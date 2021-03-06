import {Token} from "./tokens_public"
import {validatePatterns, analyzeTokenClasses, countLineTerminators} from "./lexer"
import {cloneObj, isEmpty, map, isArray, first, forEach, merge, last, keys} from "../utils/utils"

export type TokenConstructor = Function

export interface ILexingResult {
    tokens:Token[]
    groups:{ [groupName:string]:Token }
    errors:ILexingError[]
}

export enum LexerDefinitionErrorType {
    MISSING_PATTERN,
    INVALID_PATTERN,
    EOI_ANCHOR_FOUND,
    UNSUPPORTED_FLAGS_FOUND,
    DUPLICATE_PATTERNS_FOUND,
    INVALID_GROUP_TYPE_FOUND,
    PUSH_MODE_DOES_NOT_EXIST
}

export interface ILexerDefinitionError {
    message:string
    type:LexerDefinitionErrorType
    tokenClasses:Function[]
}

export interface ILexingError {
    line:number
    column:number
    length:number
    message:string
}

export type SingleModeLexerDefinition = TokenConstructor[]
export type MultiModeLexerWDefinition = { [modeName:string]:TokenConstructor[] }

export class Lexer {

    public static SKIPPED = {
        description: "This marks a skipped Token pattern, this means each token identified by it will" +
                     "be consumed and then throw into oblivion, this can be used to for example: skip whitespace."
    }

    public static NA = /NOT_APPLICABLE/
    public lexerDefinitionErrors = []

    protected modes:string[] = []
    protected allPatterns:{ [modeName:string]:RegExp[] } = {}
    protected patternIdxToClass:{ [modeName:string]:Function[] } = {}
    protected patternIdxToGroup:{ [modeName:string]:string[] } = {}
    protected patternIdxToLongerAltIdx:{ [modeName:string]:number[] } = {}
    protected patternIdxToCanLineTerminator:{ [modeName:string]:boolean[] } = {}
    protected patternIdxToPushMode:{ [modeName:string]:string[] } = {}
    protected patternIdxToPopMode:{ [modeName:string]:boolean[] } = {}
    protected emptyGroups:{ [groupName:string]:Token } = {}


    /**
     * @param {SingleModeLexerDefinition | MultiModeLexerWDefinition} lexerDefinition -
     *  Structure composed of  constructor functions for the Tokens types this lexer will support.
     *
     *  In the case of {SingleModeLexerDefinition} the structure is simply an array of Token constructors.
     *  In the case of {MultiModeLexerWDefinition} the structure is an object where each value is an array of Token constructors.
     *
     *  for example:
     *  {
     *     "modeX" : [Token1, Token2]
     *     "modeY" : [Token3, Token4]
     *  }
     *
     *  A lexer with {MultiModeLexerWDefinition} is simply multiple Lexers where only one (mode) can be active at the same time.
     *  This is useful for lexing languages where there are different lexing rules depending on context.
     *
     *  The current lexing mode is selected via a "mode stack".
     *  The last (peek) value in the stack will be the current mode of the lexer.
     *
     *  Each Token class can define that it will cause the Lexer to (after consuming an instance of the Token)
     *  1. PUSH_MODE : push a new mode to the "mode stack"
     *  2. POP_MODE  : pop the last mode from the "mode stack"
     *
     *  Examples:
     *       export class Attribute extends Token {
     *          static PATTERN = ...
     *          static PUSH_MODE = "modeY"
     *       }
     *
     *       export class EndAttribute extends Token {
     *          static PATTERN = ...
     *          static POP_MODE = true
     *       }
     *
     *  The Token constructors must be in one of these forms:
     *
     *  1. With a PATTERN property that has a RegExp value for tokens to match:
     *     example: -->class Integer extends Token { static PATTERN = /[1-9]\d }<--
     *
     *  2. With a PATTERN property that has the value of the var Lexer.NA defined above.
     *     This is a convenience form used to avoid matching Token classes that only act as categories.
     *     example: -->class Keyword extends Token { static PATTERN = NA }<--
     *
     *
     *   The following RegExp patterns are not supported:
     *   a. '$' for match at end of input
     *   b. /b global flag
     *   c. /m multi-line flag
     *
     *   The Lexer will identify the first pattern that matches, Therefor the order of Token Constructors may be significant.
     *   For example when one pattern may match a prefix of another pattern.
     *
     *   Note that there are situations in which we may wish to order the longer pattern after the shorter one.
     *   For example: keywords vs Identifiers.
     *   'do'(/do/) and 'donald'(/w+)
     *
     *   * If the Identifier pattern appears before the 'do' pattern, both 'do' and 'donald'
     *     will be lexed as an Identifier.
     *
     *   * If the 'do' pattern appears before the Identifier pattern 'do' will be lexed correctly as a keyword.
     *     however 'donald' will be lexed as TWO separate tokens: keyword 'do' and identifier 'nald'.
     *
     *   To resolve this problem, add a static property on the keyword's constructor named: LONGER_ALT
     *   example:
     *
     *       export class Identifier extends Keyword { static PATTERN = /[_a-zA-Z][_a-zA-Z0-9]/ }
     *       export class Keyword extends Token {
     *          static PATTERN = lex.NA
     *          static LONGER_ALT = Identifier
     *       }
     *       export class Do extends Keyword { static PATTERN = /do/ }
     *       export class While extends Keyword { static PATTERN = /while/ }
     *       export class Return extends Keyword { static PATTERN = /return/ }
     *
     *   The lexer will then also attempt to match a (longer) Identifier each time a keyword is matched.
     *
     *
     * @param {boolean} [deferDefinitionErrorsHandling=false]
     *                  an optional flag indicating that lexer definition errors
     *                  should not automatically cause an error to be raised.
     *                  This can be useful when wishing to indicate lexer errors in another manner
     *                  than simply throwing an error (for example in an online playground).
     */
    constructor(protected lexerDefinition:SingleModeLexerDefinition | MultiModeLexerWDefinition,
                deferDefinitionErrorsHandling:boolean = false) {


        // Convert SingleModeLexerDefinition into a MultiModeLexerDefinition with
        if (isArray(lexerDefinition)) {
            lexerDefinition = {
                "default_mode": <SingleModeLexerDefinition>lexerDefinition
            }
        }

        let allModeNames = keys(lexerDefinition)
        forEach(lexerDefinition, (currModDef:TokenConstructor[], currModName) => {
            this.modes.push(currModName)
            this.lexerDefinitionErrors = this.lexerDefinitionErrors.concat(
                validatePatterns(<SingleModeLexerDefinition>currModDef, allModeNames))

            // If definition errors were encountered, the analysis phase may fail unexpectedly/
            // Considering a lexer with definition errors may never be used, there is no point
            // to performing the analysis anyhow...
            if (isEmpty(this.lexerDefinitionErrors)) {
                let currAnalyzeResult = analyzeTokenClasses(currModDef)
                this.allPatterns[currModName] = currAnalyzeResult.allPatterns
                this.patternIdxToClass[currModName] = currAnalyzeResult.patternIdxToClass
                this.patternIdxToGroup[currModName] = currAnalyzeResult.patternIdxToGroup
                this.patternIdxToLongerAltIdx[currModName] = currAnalyzeResult.patternIdxToLongerAltIdx
                this.patternIdxToCanLineTerminator[currModName] = currAnalyzeResult.patternIdxToCanLineTerminator
                this.patternIdxToPushMode[currModName] = currAnalyzeResult.patternIdxToPushMode
                this.patternIdxToPopMode[currModName] = currAnalyzeResult.patternIdxToPopMode
                this.emptyGroups = merge(this.emptyGroups, currAnalyzeResult.emptyGroups)
            }
        })

        if (!isEmpty(this.lexerDefinitionErrors) && !deferDefinitionErrorsHandling) {
            let allErrMessages = map(this.lexerDefinitionErrors, (error) => {
                return error.message
            })
            let allErrMessagesString = allErrMessages.join("-----------------------\n")
            throw new Error("Errors detected in definition of Lexer:\n" + allErrMessagesString)
        }
    }

    /**
     * Will lex(Tokenize) a string.
     * Note that this can be called repeatedly on different strings as this method
     * does not modify the state of the Lexer.
     *
     * @param {string} text - the string to lex
     * @param {string} [initialMode] - The initial Lexer Mode to start with, by default this will be the first mode in the lexer's
     *                                 definition. If the lexer has no explicit modes it will be the implicit single 'default_mode' mode.
     *
     * @returns {{tokens: {Token}[], errors: string[]}}
     */
    public tokenize(text:string,
                    initialMode:string = first(this.modes)):ILexingResult {

        if (!isEmpty(this.lexerDefinitionErrors)) {
            let allErrMessages = map(this.lexerDefinitionErrors, (error) => {
                return error.message
            })
            let allErrMessagesString = allErrMessages.join("-----------------------\n")
            throw new Error("Unable to Tokenize because Errors detected in definition of Lexer:\n" + allErrMessagesString)
        }

        let match, i, j, matchAlt, longerAltIdx, matchedImage, imageLength, group, tokClass, newToken, errLength,
            fixForEndingInLT, c, droppedChar, lastLTIdx, msg, lastCharIsLT
        let orgInput = text
        let offset = 0
        let matchedTokens = []
        let errors:ILexingError[] = []
        let line = 1
        let column = 1
        let groups:any = cloneObj(this.emptyGroups)

        let currModePatterns = []
        let currModePatternsLength = 0
        let currModePatternIdxToLongerAltIdx = []
        let currModePatternIdxToGroup = []
        let currModePatternIdxToClass = []
        let currModePatternIdxToCanLineTerminator = []
        let patternIdxToPushMode = []
        let patternIdxToPopMode = []

        let modeStack = []
        let pop_mode = (popToken) => {
            // TODO: perhaps avoid this error in the edge case there is no more input?
            if (modeStack.length === 1) {
                // if we try to pop the last mode there lexer will no longer have ANY mode.
                // thus the pop is ignored, an error will be created and the lexer will continue parsing in the previous mode.
                let msg = `Unable to pop Lexer Mode after encountering Token ->${popToken.image}<- The Mode Stack is empty`
                errors.push({line: popToken.startLine, column: popToken.startColumn, length: popToken.image.length, message: msg})
            }
            else {
                modeStack.pop()
                let newMode = last(modeStack)
                currModePatterns = this.allPatterns[newMode]
                currModePatternsLength = currModePatterns.length
                currModePatternIdxToLongerAltIdx = this.patternIdxToLongerAltIdx[newMode]
                currModePatternIdxToGroup = this.patternIdxToGroup[newMode]
                currModePatternIdxToClass = this.patternIdxToClass[newMode]
                currModePatternIdxToCanLineTerminator = this.patternIdxToCanLineTerminator[newMode]
                patternIdxToPushMode = this.patternIdxToPushMode[newMode]
                patternIdxToPopMode = this.patternIdxToPopMode[newMode]
            }
        }

        let push_mode = (newMode) => {
            modeStack.push(newMode)
            currModePatterns = this.allPatterns[newMode]
            currModePatternsLength = currModePatterns.length
            currModePatternIdxToLongerAltIdx = this.patternIdxToLongerAltIdx[newMode]
            currModePatternIdxToGroup = this.patternIdxToGroup[newMode]
            currModePatternIdxToClass = this.patternIdxToClass[newMode]
            currModePatternIdxToCanLineTerminator = this.patternIdxToCanLineTerminator[newMode]
            patternIdxToPushMode = this.patternIdxToPushMode[newMode]
            patternIdxToPopMode = this.patternIdxToPopMode[newMode]
        }

        push_mode(initialMode)

        while (text.length > 0) {
            match = null
            for (i = 0; i < currModePatternsLength; i++) {
                match = currModePatterns[i].exec(text)
                if (match !== null) {
                    // even though this pattern matched we must try a another longer alternative.
                    // this can be used to prioritize keywords over identifiers
                    longerAltIdx = currModePatternIdxToLongerAltIdx[i]
                    if (longerAltIdx) {
                        matchAlt = currModePatterns[longerAltIdx].exec(text)
                        if (matchAlt && matchAlt[0].length > match[0].length) {
                            match = matchAlt
                            i = longerAltIdx
                        }
                    }
                    break
                }
            }
            // successful match
            if (match !== null) {
                matchedImage = match[0]
                imageLength = matchedImage.length
                group = currModePatternIdxToGroup[i]
                if (group !== undefined) {
                    tokClass = currModePatternIdxToClass[i]
                    newToken = new tokClass(matchedImage, offset, line, column)
                    if (group === "default") {
                        matchedTokens.push(newToken)
                    }
                    else {
                        groups[group].push(newToken)
                    }
                }
                text = text.slice(imageLength)
                offset = offset + imageLength
                column = column + imageLength // TODO: with newlines the column may be assigned twice

                if (currModePatternIdxToCanLineTerminator[i]) {
                    let lineTerminatorsInMatch = countLineTerminators(matchedImage)
                    // TODO: identify edge case of one token ending in '\r' and another one starting with '\n'
                    if (lineTerminatorsInMatch !== 0) {
                        line = line + lineTerminatorsInMatch

                        lastLTIdx = imageLength - 1
                        while (lastLTIdx >= 0) {
                            c = matchedImage.charCodeAt(lastLTIdx)
                            // scan in reverse to find last lineTerminator in image
                            if (c === 13 || c === 10) { // '\r' or '\n'
                                break
                            }
                            lastLTIdx--
                        }
                        column = imageLength - lastLTIdx

                        if (group !== undefined) { // a none skipped multi line Token, need to update endLine/endColumn
                            lastCharIsLT = lastLTIdx === imageLength - 1
                            fixForEndingInLT = lastCharIsLT ? -1 : 0

                            if (!(lineTerminatorsInMatch === 1 && lastCharIsLT)) {
                                // if a token ends in a LT that last LT only affects the line numbering of following Tokens
                                newToken.endLine = line + fixForEndingInLT
                                // the last LT in a token does not affect the endColumn either as the [columnStart ... columnEnd)
                                // inclusive to exclusive range.
                                newToken.endColumn = column - 1 + -fixForEndingInLT
                            }
                            // else single LT in the last character of a token, no need to modify the endLine/EndColumn
                        }
                    }
                }

                // mode handling, must pop before pushing if a Token both acts as both
                // otherwise it would be a NO-OP
                if (patternIdxToPopMode[i]) {
                    pop_mode(newToken)
                }
                if (patternIdxToPushMode[i]) {
                    push_mode(patternIdxToPushMode[i])
                }
            }
            else { // error recovery, drop characters until we identify a valid token's start point
                let errorStartOffset = offset
                let errorLine = line
                let errorColumn = column
                let foundResyncPoint = false
                while (!foundResyncPoint && text.length > 0) {
                    // drop chars until we succeed in matching something
                    droppedChar = text.charCodeAt(0)
                    if (droppedChar === 10 || // '\n'
                        (droppedChar === 13 &&
                        (text.length === 1 || (text.length > 1 && text.charCodeAt(1) !== 10)))) { //'\r' not followed by '\n'
                        line++
                        column = 1
                    }
                    else { // this else also matches '\r\n' which is fine, the '\n' will be counted
                        // either when skipping the next char, or when consuming the following pattern
                        // (which will have to start in a '\n' if we manage to consume it)
                        column++
                    }

                    text = text.substr(1)
                    offset++
                    for (j = 0; j < currModePatterns.length; j++) {
                        foundResyncPoint = currModePatterns[j].test(text)
                        if (foundResyncPoint) {
                            break
                        }
                    }
                }

                errLength = offset - errorStartOffset
                // at this point we either re-synced or reached the end of the input text
                msg = `unexpected character: ->${orgInput.charAt(errorStartOffset)}<- at offset: ${errorStartOffset},` +
                    ` skipped ${offset - errorStartOffset} characters.`
                errors.push({line: errorLine, column: errorColumn, length: errLength, message: msg})
            }
        }

        return {tokens: matchedTokens, groups: groups, errors: errors}
    }
}
