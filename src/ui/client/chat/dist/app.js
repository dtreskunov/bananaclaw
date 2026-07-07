var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/path-to-regexp/dist/index.js
var require_dist = __commonJS({
  "node_modules/path-to-regexp/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PathError = exports.TokenData = void 0;
    exports.parse = parse;
    exports.compile = compile2;
    exports.match = match2;
    exports.pathToRegexp = pathToRegexp;
    exports.stringify = stringify;
    var DEFAULT_DELIMITER = "/";
    var NOOP_VALUE = (value) => value;
    var ID_START = /^[$_\p{ID_Start}]$/u;
    var ID_CONTINUE = /^[$\u200c\u200d\p{ID_Continue}]$/u;
    var ID = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
    function escapeText(str) {
      return str.replace(/[{}()\[\]+?!:*\\]/g, "\\$&");
    }
    function escape(str) {
      return str.replace(/[.+*?^${}()[\]|/\\]/g, "\\$&");
    }
    var TokenData = class {
      constructor(tokens, originalPath) {
        this.tokens = tokens;
        this.originalPath = originalPath;
      }
    };
    exports.TokenData = TokenData;
    var PathError = class extends TypeError {
      constructor(message, originalPath) {
        let text = message;
        if (originalPath)
          text += `: ${originalPath}`;
        text += `; visit https://git.new/pathToRegexpError for info`;
        super(text);
        this.originalPath = originalPath;
      }
    };
    exports.PathError = PathError;
    function parse(str, options = {}) {
      const { encodePath = NOOP_VALUE } = options;
      const chars = [...str];
      let index = 0;
      function consumeUntil(end) {
        const output = [];
        let path = "";
        function writePath() {
          if (!path)
            return;
          output.push({
            type: "text",
            value: encodePath(path)
          });
          path = "";
        }
        while (index < chars.length) {
          const value = chars[index++];
          if (value === end) {
            writePath();
            return output;
          }
          if (value === "\\") {
            if (index === chars.length) {
              throw new PathError(`Unexpected end after \\ at index ${index}`, str);
            }
            path += chars[index++];
            continue;
          }
          if (value === ":" || value === "*") {
            const type = value === ":" ? "param" : "wildcard";
            let name = "";
            if (ID_START.test(chars[index])) {
              do {
                name += chars[index++];
              } while (ID_CONTINUE.test(chars[index]));
            } else if (chars[index] === '"') {
              let quoteStart = index;
              while (index < chars.length) {
                if (chars[++index] === '"') {
                  index++;
                  quoteStart = 0;
                  break;
                }
                if (chars[index] === "\\")
                  index++;
                name += chars[index];
              }
              if (quoteStart) {
                throw new PathError(`Unterminated quote at index ${quoteStart}`, str);
              }
            }
            if (!name) {
              throw new PathError(`Missing parameter name at index ${index}`, str);
            }
            writePath();
            output.push({ type, name });
            continue;
          }
          if (value === "{") {
            writePath();
            output.push({
              type: "group",
              tokens: consumeUntil("}")
            });
            continue;
          }
          if (value === "}" || value === "(" || value === ")" || value === "[" || value === "]" || value === "+" || value === "?" || value === "!") {
            throw new PathError(`Unexpected ${value} at index ${index - 1}`, str);
          }
          path += value;
        }
        if (end) {
          throw new PathError(`Unexpected end at index ${index}, expected ${end}`, str);
        }
        writePath();
        return output;
      }
      return new TokenData(consumeUntil(""), str);
    }
    function compile2(path, options = {}) {
      const { encode = encodeURIComponent, delimiter = DEFAULT_DELIMITER } = options;
      const data = typeof path === "object" ? path : parse(path, options);
      const fn2 = tokensToFunction(data.tokens, delimiter, encode);
      return function path2(params = {}) {
        const missing = [];
        const path3 = fn2(params, missing);
        if (missing.length) {
          throw new TypeError(`Missing parameters: ${missing.join(", ")}`);
        }
        return path3;
      };
    }
    function tokensToFunction(tokens, delimiter, encode) {
      const encoders = tokens.map((token) => tokenToFunction(token, delimiter, encode));
      return (data, missing) => {
        let result = "";
        for (const encoder of encoders) {
          result += encoder(data, missing);
        }
        return result;
      };
    }
    function tokenToFunction(token, delimiter, encode) {
      if (token.type === "text")
        return () => token.value;
      if (token.type === "group") {
        const fn2 = tokensToFunction(token.tokens, delimiter, encode);
        return (data, missing) => {
          const len = missing.length;
          const value = fn2(data, missing);
          if (missing.length === len)
            return value;
          missing.length = len;
          return "";
        };
      }
      const encodeValue = encode || NOOP_VALUE;
      if (token.type === "wildcard" && encode !== false) {
        return (data, missing) => {
          const value = data[token.name];
          if (value == null) {
            missing.push(token.name);
            return "";
          }
          if (!Array.isArray(value) || value.length === 0) {
            throw new TypeError(`Expected "${token.name}" to be a non-empty array`);
          }
          let result = "";
          for (let i5 = 0; i5 < value.length; i5++) {
            if (typeof value[i5] !== "string") {
              throw new TypeError(`Expected "${token.name}/${i5}" to be a string`);
            }
            if (i5 > 0)
              result += delimiter;
            result += encodeValue(value[i5]);
          }
          return result;
        };
      }
      return (data, missing) => {
        const value = data[token.name];
        if (value == null) {
          missing.push(token.name);
          return "";
        }
        if (typeof value !== "string") {
          throw new TypeError(`Expected "${token.name}" to be a string`);
        }
        return encodeValue(value);
      };
    }
    function match2(path, options = {}) {
      const { decode = decodeURIComponent, delimiter = DEFAULT_DELIMITER } = options;
      const { regexp, keys } = pathToRegexp(path, options);
      const decoders = keys.map((key) => {
        if (decode === false)
          return NOOP_VALUE;
        if (key.type === "param")
          return decode;
        return (value) => value.split(delimiter).map(decode);
      });
      return function match3(input) {
        const m6 = regexp.exec(input);
        if (!m6)
          return false;
        const path2 = m6[0];
        const params = /* @__PURE__ */ Object.create(null);
        for (let i5 = 1; i5 < m6.length; i5++) {
          if (m6[i5] === void 0)
            continue;
          const key = keys[i5 - 1];
          const decoder = decoders[i5 - 1];
          params[key.name] = decoder(m6[i5]);
        }
        return { path: path2, params };
      };
    }
    function pathToRegexp(path, options = {}) {
      const { delimiter = DEFAULT_DELIMITER, end = true, sensitive = false, trailing = true } = options;
      const keys = [];
      let source = "";
      let combinations = 0;
      function process(path2) {
        if (Array.isArray(path2)) {
          for (const p5 of path2)
            process(p5);
          return;
        }
        const data = typeof path2 === "object" ? path2 : parse(path2, options);
        flatten(data.tokens, 0, [], (tokens) => {
          if (combinations >= 256) {
            throw new PathError("Too many path combinations", data.originalPath);
          }
          if (combinations > 0)
            source += "|";
          source += toRegExpSource(tokens, delimiter, keys, data.originalPath);
          combinations++;
        });
      }
      process(path);
      let pattern = `^(?:${source})`;
      if (trailing)
        pattern += "(?:" + escape(delimiter) + "$)?";
      pattern += end ? "$" : "(?=" + escape(delimiter) + "|$)";
      return { regexp: new RegExp(pattern, sensitive ? "" : "i"), keys };
    }
    function flatten(tokens, index, result, callback) {
      while (index < tokens.length) {
        const token = tokens[index++];
        if (token.type === "group") {
          const len = result.length;
          flatten(token.tokens, 0, result, (seq) => flatten(tokens, index, seq, callback));
          result.length = len;
          continue;
        }
        result.push(token);
      }
      callback(result);
    }
    function toRegExpSource(tokens, delimiter, keys, originalPath) {
      let result = "";
      let backtrack = "";
      let wildcardBacktrack = "";
      let prevCaptureType = 0;
      let hasSegmentCapture = 0;
      let index = 0;
      function hasInSegment(index2, type) {
        while (index2 < tokens.length) {
          const token = tokens[index2++];
          if (token.type === type)
            return true;
          if (token.type === "text") {
            if (token.value.includes(delimiter))
              break;
          }
        }
        return false;
      }
      function peekText(index2) {
        let result2 = "";
        while (index2 < tokens.length) {
          const token = tokens[index2++];
          if (token.type !== "text")
            break;
          result2 += token.value;
        }
        return result2;
      }
      while (index < tokens.length) {
        const token = tokens[index++];
        if (token.type === "text") {
          result += escape(token.value);
          backtrack += token.value;
          if (prevCaptureType === 2)
            wildcardBacktrack += token.value;
          if (token.value.includes(delimiter))
            hasSegmentCapture = 0;
          continue;
        }
        if (token.type === "param" || token.type === "wildcard") {
          if (prevCaptureType && !backtrack) {
            throw new PathError(`Missing text before "${token.name}" ${token.type}`, originalPath);
          }
          if (token.type === "param") {
            result += hasSegmentCapture & 2 ? `(${negate(delimiter, backtrack)}+)` : hasInSegment(index, "wildcard") ? `(${negate(delimiter, peekText(index))}+)` : hasSegmentCapture & 1 ? `(${negate(delimiter, backtrack)}+|${escape(backtrack)})` : `(${negate(delimiter, "")}+)`;
            hasSegmentCapture |= prevCaptureType = 1;
          } else {
            result += hasSegmentCapture & 2 ? `(${negate(backtrack, "")}+)` : wildcardBacktrack ? `(${negate(wildcardBacktrack, "")}+|${negate(delimiter, "")}+)` : `([^]+)`;
            wildcardBacktrack = "";
            hasSegmentCapture |= prevCaptureType = 2;
          }
          keys.push(token);
          backtrack = "";
          continue;
        }
        throw new TypeError(`Unknown token type: ${token.type}`);
      }
      return result;
    }
    function negate(a4, b5) {
      if (b5.length > a4.length)
        return negate(b5, a4);
      if (a4 === b5)
        b5 = "";
      if (b5.length > 1)
        return `(?:(?!${escape(a4)}|${escape(b5)})[^])`;
      if (a4.length > 1)
        return `(?:(?!${escape(a4)})[^${escape(b5)}])`;
      return `[^${escape(a4 + b5)}]`;
    }
    function stringifyTokens(tokens, index) {
      let value = "";
      while (index < tokens.length) {
        const token = tokens[index++];
        if (token.type === "text") {
          value += escapeText(token.value);
          continue;
        }
        if (token.type === "group") {
          value += "{" + stringifyTokens(token.tokens, 0) + "}";
          continue;
        }
        if (token.type === "param") {
          value += ":" + stringifyName(token.name, tokens[index]);
          continue;
        }
        if (token.type === "wildcard") {
          value += "*" + stringifyName(token.name, tokens[index]);
          continue;
        }
        throw new TypeError(`Unknown token type: ${token.type}`);
      }
      return value;
    }
    function stringify(data) {
      return stringifyTokens(data.tokens, 0);
    }
    function stringifyName(name, next) {
      if (!ID.test(name))
        return JSON.stringify(name);
      if ((next === null || next === void 0 ? void 0 : next.type) === "text" && ID_CONTINUE.test(next.value[0])) {
        return JSON.stringify(name);
      }
      return name;
    }
  }
});

// node_modules/highlight.js/lib/core.js
var require_core = __commonJS({
  "node_modules/highlight.js/lib/core.js"(exports, module) {
    function deepFreeze(obj) {
      if (obj instanceof Map) {
        obj.clear = obj.delete = obj.set = function() {
          throw new Error("map is read-only");
        };
      } else if (obj instanceof Set) {
        obj.add = obj.clear = obj.delete = function() {
          throw new Error("set is read-only");
        };
      }
      Object.freeze(obj);
      Object.getOwnPropertyNames(obj).forEach((name) => {
        const prop = obj[name];
        const type = typeof prop;
        if ((type === "object" || type === "function") && !Object.isFrozen(prop)) {
          deepFreeze(prop);
        }
      });
      return obj;
    }
    var Response = class {
      /**
       * @param {CompiledMode} mode
       */
      constructor(mode) {
        if (mode.data === void 0) mode.data = {};
        this.data = mode.data;
        this.isMatchIgnored = false;
      }
      ignoreMatch() {
        this.isMatchIgnored = true;
      }
    };
    function escapeHTML(value) {
      return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    }
    function inherit$1(original, ...objects) {
      const result = /* @__PURE__ */ Object.create(null);
      for (const key in original) {
        result[key] = original[key];
      }
      objects.forEach(function(obj) {
        for (const key in obj) {
          result[key] = obj[key];
        }
      });
      return (
        /** @type {T} */
        result
      );
    }
    var SPAN_CLOSE = "</span>";
    var emitsWrappingTags = (node) => {
      return !!node.scope;
    };
    var scopeToCSSClass = (name, { prefix }) => {
      if (name.startsWith("language:")) {
        return name.replace("language:", "language-");
      }
      if (name.includes(".")) {
        const pieces = name.split(".");
        return [
          `${prefix}${pieces.shift()}`,
          ...pieces.map((x6, i5) => `${x6}${"_".repeat(i5 + 1)}`)
        ].join(" ");
      }
      return `${prefix}${name}`;
    };
    var HTMLRenderer = class {
      /**
       * Creates a new HTMLRenderer
       *
       * @param {Tree} parseTree - the parse tree (must support `walk` API)
       * @param {{classPrefix: string}} options
       */
      constructor(parseTree, options) {
        this.buffer = "";
        this.classPrefix = options.classPrefix;
        parseTree.walk(this);
      }
      /**
       * Adds texts to the output stream
       *
       * @param {string} text */
      addText(text) {
        this.buffer += escapeHTML(text);
      }
      /**
       * Adds a node open to the output stream (if needed)
       *
       * @param {Node} node */
      openNode(node) {
        if (!emitsWrappingTags(node)) return;
        const className = scopeToCSSClass(
          node.scope,
          { prefix: this.classPrefix }
        );
        this.span(className);
      }
      /**
       * Adds a node close to the output stream (if needed)
       *
       * @param {Node} node */
      closeNode(node) {
        if (!emitsWrappingTags(node)) return;
        this.buffer += SPAN_CLOSE;
      }
      /**
       * returns the accumulated buffer
      */
      value() {
        return this.buffer;
      }
      // helpers
      /**
       * Builds a span element
       *
       * @param {string} className */
      span(className) {
        this.buffer += `<span class="${className}">`;
      }
    };
    var newNode = (opts = {}) => {
      const result = { children: [] };
      Object.assign(result, opts);
      return result;
    };
    var TokenTree = class _TokenTree {
      constructor() {
        this.rootNode = newNode();
        this.stack = [this.rootNode];
      }
      get top() {
        return this.stack[this.stack.length - 1];
      }
      get root() {
        return this.rootNode;
      }
      /** @param {Node} node */
      add(node) {
        this.top.children.push(node);
      }
      /** @param {string} scope */
      openNode(scope) {
        const node = newNode({ scope });
        this.add(node);
        this.stack.push(node);
      }
      closeNode() {
        if (this.stack.length > 1) {
          return this.stack.pop();
        }
        return void 0;
      }
      closeAllNodes() {
        while (this.closeNode()) ;
      }
      toJSON() {
        return JSON.stringify(this.rootNode, null, 4);
      }
      /**
       * @typedef { import("./html_renderer").Renderer } Renderer
       * @param {Renderer} builder
       */
      walk(builder) {
        return this.constructor._walk(builder, this.rootNode);
      }
      /**
       * @param {Renderer} builder
       * @param {Node} node
       */
      static _walk(builder, node) {
        if (typeof node === "string") {
          builder.addText(node);
        } else if (node.children) {
          builder.openNode(node);
          node.children.forEach((child) => this._walk(builder, child));
          builder.closeNode(node);
        }
        return builder;
      }
      /**
       * @param {Node} node
       */
      static _collapse(node) {
        if (typeof node === "string") return;
        if (!node.children) return;
        if (node.children.every((el) => typeof el === "string")) {
          node.children = [node.children.join("")];
        } else {
          node.children.forEach((child) => {
            _TokenTree._collapse(child);
          });
        }
      }
    };
    var TokenTreeEmitter = class extends TokenTree {
      /**
       * @param {*} options
       */
      constructor(options) {
        super();
        this.options = options;
      }
      /**
       * @param {string} text
       */
      addText(text) {
        if (text === "") {
          return;
        }
        this.add(text);
      }
      /** @param {string} scope */
      startScope(scope) {
        this.openNode(scope);
      }
      endScope() {
        this.closeNode();
      }
      /**
       * @param {Emitter & {root: DataNode}} emitter
       * @param {string} name
       */
      __addSublanguage(emitter, name) {
        const node = emitter.root;
        if (name) node.scope = `language:${name}`;
        this.add(node);
      }
      toHTML() {
        const renderer = new HTMLRenderer(this, this.options);
        return renderer.value();
      }
      finalize() {
        this.closeAllNodes();
        return true;
      }
    };
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function anyNumberOfTimes(re) {
      return concat("(?:", re, ")*");
    }
    function optional(re) {
      return concat("(?:", re, ")?");
    }
    function concat(...args) {
      const joined = args.map((x6) => source(x6)).join("");
      return joined;
    }
    function stripOptionsFromArgs(args) {
      const opts = args[args.length - 1];
      if (typeof opts === "object" && opts.constructor === Object) {
        args.splice(args.length - 1, 1);
        return opts;
      } else {
        return {};
      }
    }
    function either(...args) {
      const opts = stripOptionsFromArgs(args);
      const joined = "(" + (opts.capture ? "" : "?:") + args.map((x6) => source(x6)).join("|") + ")";
      return joined;
    }
    function countMatchGroups(re) {
      return new RegExp(re.toString() + "|").exec("").length - 1;
    }
    function startsWith(re, lexeme) {
      const match2 = re && re.exec(lexeme);
      return match2 && match2.index === 0;
    }
    var BACKREF_RE = /\[(?:[^\\\]]|\\.)*\]|\(\??|\\([1-9][0-9]*)|\\./;
    function _rewriteBackreferences(regexps, { joinWith }) {
      let numCaptures = 0;
      return regexps.map((regex) => {
        numCaptures += 1;
        const offset = numCaptures;
        let re = source(regex);
        let out = "";
        while (re.length > 0) {
          const match2 = BACKREF_RE.exec(re);
          if (!match2) {
            out += re;
            break;
          }
          out += re.substring(0, match2.index);
          re = re.substring(match2.index + match2[0].length);
          if (match2[0][0] === "\\" && match2[1]) {
            out += "\\" + String(Number(match2[1]) + offset);
          } else {
            out += match2[0];
            if (match2[0] === "(") {
              numCaptures++;
            }
          }
        }
        return out;
      }).map((re) => `(${re})`).join(joinWith);
    }
    var MATCH_NOTHING_RE = /\b\B/;
    var IDENT_RE = "[a-zA-Z]\\w*";
    var UNDERSCORE_IDENT_RE = "[a-zA-Z_]\\w*";
    var NUMBER_RE = "\\b\\d+(\\.\\d+)?";
    var C_NUMBER_RE = "(-?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)";
    var BINARY_NUMBER_RE = "\\b(0b[01]+)";
    var RE_STARTERS_RE = "!|!=|!==|%|%=|&|&&|&=|\\*|\\*=|\\+|\\+=|,|-|-=|/=|/|:|;|<<|<<=|<=|<|===|==|=|>>>=|>>=|>=|>>>|>>|>|\\?|\\[|\\{|\\(|\\^|\\^=|\\||\\|=|\\|\\||~";
    var SHEBANG = (opts = {}) => {
      const beginShebang = /^#![ ]*\//;
      if (opts.binary) {
        opts.begin = concat(
          beginShebang,
          /.*\b/,
          opts.binary,
          /\b.*/
        );
      }
      return inherit$1({
        scope: "meta",
        begin: beginShebang,
        end: /$/,
        relevance: 0,
        /** @type {ModeCallback} */
        "on:begin": (m6, resp) => {
          if (m6.index !== 0) resp.ignoreMatch();
        }
      }, opts);
    };
    var BACKSLASH_ESCAPE = {
      begin: "\\\\[\\s\\S]",
      relevance: 0
    };
    var APOS_STRING_MODE = {
      scope: "string",
      begin: "'",
      end: "'",
      illegal: "\\n",
      contains: [BACKSLASH_ESCAPE]
    };
    var QUOTE_STRING_MODE = {
      scope: "string",
      begin: '"',
      end: '"',
      illegal: "\\n",
      contains: [BACKSLASH_ESCAPE]
    };
    var PHRASAL_WORDS_MODE = {
      begin: /\b(a|an|the|are|I'm|isn't|don't|doesn't|won't|but|just|should|pretty|simply|enough|gonna|going|wtf|so|such|will|you|your|they|like|more)\b/
    };
    var COMMENT = function(begin, end, modeOptions = {}) {
      const mode = inherit$1(
        {
          scope: "comment",
          begin,
          end,
          contains: []
        },
        modeOptions
      );
      mode.contains.push({
        scope: "doctag",
        // hack to avoid the space from being included. the space is necessary to
        // match here to prevent the plain text rule below from gobbling up doctags
        begin: "[ ]*(?=(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):)",
        end: /(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):/,
        excludeBegin: true,
        relevance: 0
      });
      const ENGLISH_WORD = either(
        // list of common 1 and 2 letter words in English
        "I",
        "a",
        "is",
        "so",
        "us",
        "to",
        "at",
        "if",
        "in",
        "it",
        "on",
        // note: this is not an exhaustive list of contractions, just popular ones
        /[A-Za-z]+['](d|ve|re|ll|t|s|n)/,
        // contractions - can't we'd they're let's, etc
        /[A-Za-z]+[-][a-z]+/,
        // `no-way`, etc.
        /[A-Za-z][a-z]{2,}/
        // allow capitalized words at beginning of sentences
      );
      mode.contains.push(
        {
          // TODO: how to include ", (, ) without breaking grammars that use these for
          // comment delimiters?
          // begin: /[ ]+([()"]?([A-Za-z'-]{3,}|is|a|I|so|us|[tT][oO]|at|if|in|it|on)[.]?[()":]?([.][ ]|[ ]|\))){3}/
          // ---
          // this tries to find sequences of 3 english words in a row (without any
          // "programming" type syntax) this gives us a strong signal that we've
          // TRULY found a comment - vs perhaps scanning with the wrong language.
          // It's possible to find something that LOOKS like the start of the
          // comment - but then if there is no readable text - good chance it is a
          // false match and not a comment.
          //
          // for a visual example please see:
          // https://github.com/highlightjs/highlight.js/issues/2827
          begin: concat(
            /[ ]+/,
            // necessary to prevent us gobbling up doctags like /* @author Bob Mcgill */
            "(",
            ENGLISH_WORD,
            /[.]?[:]?([.][ ]|[ ])/,
            "){3}"
          )
          // look for 3 words in a row
        }
      );
      return mode;
    };
    var C_LINE_COMMENT_MODE = COMMENT("//", "$");
    var C_BLOCK_COMMENT_MODE = COMMENT("/\\*", "\\*/");
    var HASH_COMMENT_MODE = COMMENT("#", "$");
    var NUMBER_MODE = {
      scope: "number",
      begin: NUMBER_RE,
      relevance: 0
    };
    var C_NUMBER_MODE = {
      scope: "number",
      begin: C_NUMBER_RE,
      relevance: 0
    };
    var BINARY_NUMBER_MODE = {
      scope: "number",
      begin: BINARY_NUMBER_RE,
      relevance: 0
    };
    var REGEXP_MODE = {
      scope: "regexp",
      begin: /\/(?=[^/\n]*\/)/,
      end: /\/[gimuy]*/,
      contains: [
        BACKSLASH_ESCAPE,
        {
          begin: /\[/,
          end: /\]/,
          relevance: 0,
          contains: [BACKSLASH_ESCAPE]
        }
      ]
    };
    var TITLE_MODE = {
      scope: "title",
      begin: IDENT_RE,
      relevance: 0
    };
    var UNDERSCORE_TITLE_MODE = {
      scope: "title",
      begin: UNDERSCORE_IDENT_RE,
      relevance: 0
    };
    var METHOD_GUARD = {
      // excludes method names from keyword processing
      begin: "\\.\\s*" + UNDERSCORE_IDENT_RE,
      relevance: 0
    };
    var END_SAME_AS_BEGIN = function(mode) {
      return Object.assign(
        mode,
        {
          /** @type {ModeCallback} */
          "on:begin": (m6, resp) => {
            resp.data._beginMatch = m6[1];
          },
          /** @type {ModeCallback} */
          "on:end": (m6, resp) => {
            if (resp.data._beginMatch !== m6[1]) resp.ignoreMatch();
          }
        }
      );
    };
    var MODES = /* @__PURE__ */ Object.freeze({
      __proto__: null,
      APOS_STRING_MODE,
      BACKSLASH_ESCAPE,
      BINARY_NUMBER_MODE,
      BINARY_NUMBER_RE,
      COMMENT,
      C_BLOCK_COMMENT_MODE,
      C_LINE_COMMENT_MODE,
      C_NUMBER_MODE,
      C_NUMBER_RE,
      END_SAME_AS_BEGIN,
      HASH_COMMENT_MODE,
      IDENT_RE,
      MATCH_NOTHING_RE,
      METHOD_GUARD,
      NUMBER_MODE,
      NUMBER_RE,
      PHRASAL_WORDS_MODE,
      QUOTE_STRING_MODE,
      REGEXP_MODE,
      RE_STARTERS_RE,
      SHEBANG,
      TITLE_MODE,
      UNDERSCORE_IDENT_RE,
      UNDERSCORE_TITLE_MODE
    });
    function skipIfHasPrecedingDot(match2, response) {
      const before = match2.input[match2.index - 1];
      if (before === ".") {
        response.ignoreMatch();
      }
    }
    function scopeClassName(mode, _parent) {
      if (mode.className !== void 0) {
        mode.scope = mode.className;
        delete mode.className;
      }
    }
    function beginKeywords(mode, parent) {
      if (!parent) return;
      if (!mode.beginKeywords) return;
      mode.begin = "\\b(" + mode.beginKeywords.split(" ").join("|") + ")(?!\\.)(?=\\b|\\s)";
      mode.__beforeBegin = skipIfHasPrecedingDot;
      mode.keywords = mode.keywords || mode.beginKeywords;
      delete mode.beginKeywords;
      if (mode.relevance === void 0) mode.relevance = 0;
    }
    function compileIllegal(mode, _parent) {
      if (!Array.isArray(mode.illegal)) return;
      mode.illegal = either(...mode.illegal);
    }
    function compileMatch(mode, _parent) {
      if (!mode.match) return;
      if (mode.begin || mode.end) throw new Error("begin & end are not supported with match");
      mode.begin = mode.match;
      delete mode.match;
    }
    function compileRelevance(mode, _parent) {
      if (mode.relevance === void 0) mode.relevance = 1;
    }
    var beforeMatchExt = (mode, parent) => {
      if (!mode.beforeMatch) return;
      if (mode.starts) throw new Error("beforeMatch cannot be used with starts");
      const originalMode = Object.assign({}, mode);
      Object.keys(mode).forEach((key) => {
        delete mode[key];
      });
      mode.keywords = originalMode.keywords;
      mode.begin = concat(originalMode.beforeMatch, lookahead(originalMode.begin));
      mode.starts = {
        relevance: 0,
        contains: [
          Object.assign(originalMode, { endsParent: true })
        ]
      };
      mode.relevance = 0;
      delete originalMode.beforeMatch;
    };
    var COMMON_KEYWORDS = [
      "of",
      "and",
      "for",
      "in",
      "not",
      "or",
      "if",
      "then",
      "parent",
      // common variable name
      "list",
      // common variable name
      "value"
      // common variable name
    ];
    var DEFAULT_KEYWORD_SCOPE = "keyword";
    function compileKeywords(rawKeywords, caseInsensitive, scopeName = DEFAULT_KEYWORD_SCOPE) {
      const compiledKeywords = /* @__PURE__ */ Object.create(null);
      if (typeof rawKeywords === "string") {
        compileList(scopeName, rawKeywords.split(" "));
      } else if (Array.isArray(rawKeywords)) {
        compileList(scopeName, rawKeywords);
      } else {
        Object.keys(rawKeywords).forEach(function(scopeName2) {
          Object.assign(
            compiledKeywords,
            compileKeywords(rawKeywords[scopeName2], caseInsensitive, scopeName2)
          );
        });
      }
      return compiledKeywords;
      function compileList(scopeName2, keywordList) {
        if (caseInsensitive) {
          keywordList = keywordList.map((x6) => x6.toLowerCase());
        }
        keywordList.forEach(function(keyword) {
          const pair = keyword.split("|");
          compiledKeywords[pair[0]] = [scopeName2, scoreForKeyword(pair[0], pair[1])];
        });
      }
    }
    function scoreForKeyword(keyword, providedScore) {
      if (providedScore) {
        return Number(providedScore);
      }
      return commonKeyword(keyword) ? 0 : 1;
    }
    function commonKeyword(keyword) {
      return COMMON_KEYWORDS.includes(keyword.toLowerCase());
    }
    var seenDeprecations = {};
    var error = (message) => {
      console.error(message);
    };
    var warn = (message, ...args) => {
      console.log(`WARN: ${message}`, ...args);
    };
    var deprecated = (version2, message) => {
      if (seenDeprecations[`${version2}/${message}`]) return;
      console.log(`Deprecated as of ${version2}. ${message}`);
      seenDeprecations[`${version2}/${message}`] = true;
    };
    var MultiClassError = new Error();
    function remapScopeNames(mode, regexes, { key }) {
      let offset = 0;
      const scopeNames = mode[key];
      const emit = {};
      const positions = {};
      for (let i5 = 1; i5 <= regexes.length; i5++) {
        positions[i5 + offset] = scopeNames[i5];
        emit[i5 + offset] = true;
        offset += countMatchGroups(regexes[i5 - 1]);
      }
      mode[key] = positions;
      mode[key]._emit = emit;
      mode[key]._multi = true;
    }
    function beginMultiClass(mode) {
      if (!Array.isArray(mode.begin)) return;
      if (mode.skip || mode.excludeBegin || mode.returnBegin) {
        error("skip, excludeBegin, returnBegin not compatible with beginScope: {}");
        throw MultiClassError;
      }
      if (typeof mode.beginScope !== "object" || mode.beginScope === null) {
        error("beginScope must be object");
        throw MultiClassError;
      }
      remapScopeNames(mode, mode.begin, { key: "beginScope" });
      mode.begin = _rewriteBackreferences(mode.begin, { joinWith: "" });
    }
    function endMultiClass(mode) {
      if (!Array.isArray(mode.end)) return;
      if (mode.skip || mode.excludeEnd || mode.returnEnd) {
        error("skip, excludeEnd, returnEnd not compatible with endScope: {}");
        throw MultiClassError;
      }
      if (typeof mode.endScope !== "object" || mode.endScope === null) {
        error("endScope must be object");
        throw MultiClassError;
      }
      remapScopeNames(mode, mode.end, { key: "endScope" });
      mode.end = _rewriteBackreferences(mode.end, { joinWith: "" });
    }
    function scopeSugar(mode) {
      if (mode.scope && typeof mode.scope === "object" && mode.scope !== null) {
        mode.beginScope = mode.scope;
        delete mode.scope;
      }
    }
    function MultiClass(mode) {
      scopeSugar(mode);
      if (typeof mode.beginScope === "string") {
        mode.beginScope = { _wrap: mode.beginScope };
      }
      if (typeof mode.endScope === "string") {
        mode.endScope = { _wrap: mode.endScope };
      }
      beginMultiClass(mode);
      endMultiClass(mode);
    }
    function compileLanguage(language) {
      function langRe(value, global) {
        return new RegExp(
          source(value),
          "m" + (language.case_insensitive ? "i" : "") + (language.unicodeRegex ? "u" : "") + (global ? "g" : "")
        );
      }
      class MultiRegex {
        constructor() {
          this.matchIndexes = {};
          this.regexes = [];
          this.matchAt = 1;
          this.position = 0;
        }
        // @ts-ignore
        addRule(re, opts) {
          opts.position = this.position++;
          this.matchIndexes[this.matchAt] = opts;
          this.regexes.push([opts, re]);
          this.matchAt += countMatchGroups(re) + 1;
        }
        compile() {
          if (this.regexes.length === 0) {
            this.exec = () => null;
          }
          const terminators = this.regexes.map((el) => el[1]);
          this.matcherRe = langRe(_rewriteBackreferences(terminators, { joinWith: "|" }), true);
          this.lastIndex = 0;
        }
        /** @param {string} s */
        exec(s5) {
          this.matcherRe.lastIndex = this.lastIndex;
          const match2 = this.matcherRe.exec(s5);
          if (!match2) {
            return null;
          }
          const i5 = match2.findIndex((el, i6) => i6 > 0 && el !== void 0);
          const matchData = this.matchIndexes[i5];
          match2.splice(0, i5);
          return Object.assign(match2, matchData);
        }
      }
      class ResumableMultiRegex {
        constructor() {
          this.rules = [];
          this.multiRegexes = [];
          this.count = 0;
          this.lastIndex = 0;
          this.regexIndex = 0;
        }
        // @ts-ignore
        getMatcher(index) {
          if (this.multiRegexes[index]) return this.multiRegexes[index];
          const matcher = new MultiRegex();
          this.rules.slice(index).forEach(([re, opts]) => matcher.addRule(re, opts));
          matcher.compile();
          this.multiRegexes[index] = matcher;
          return matcher;
        }
        resumingScanAtSamePosition() {
          return this.regexIndex !== 0;
        }
        considerAll() {
          this.regexIndex = 0;
        }
        // @ts-ignore
        addRule(re, opts) {
          this.rules.push([re, opts]);
          if (opts.type === "begin") this.count++;
        }
        /** @param {string} s */
        exec(s5) {
          const m6 = this.getMatcher(this.regexIndex);
          m6.lastIndex = this.lastIndex;
          let result = m6.exec(s5);
          if (this.resumingScanAtSamePosition()) {
            if (result && result.index === this.lastIndex) ;
            else {
              const m22 = this.getMatcher(0);
              m22.lastIndex = this.lastIndex + 1;
              result = m22.exec(s5);
            }
          }
          if (result) {
            this.regexIndex += result.position + 1;
            if (this.regexIndex === this.count) {
              this.considerAll();
            }
          }
          return result;
        }
      }
      function buildModeRegex(mode) {
        const mm = new ResumableMultiRegex();
        mode.contains.forEach((term) => mm.addRule(term.begin, { rule: term, type: "begin" }));
        if (mode.terminatorEnd) {
          mm.addRule(mode.terminatorEnd, { type: "end" });
        }
        if (mode.illegal) {
          mm.addRule(mode.illegal, { type: "illegal" });
        }
        return mm;
      }
      function compileMode(mode, parent) {
        const cmode = (
          /** @type CompiledMode */
          mode
        );
        if (mode.isCompiled) return cmode;
        [
          scopeClassName,
          // do this early so compiler extensions generally don't have to worry about
          // the distinction between match/begin
          compileMatch,
          MultiClass,
          beforeMatchExt
        ].forEach((ext) => ext(mode, parent));
        language.compilerExtensions.forEach((ext) => ext(mode, parent));
        mode.__beforeBegin = null;
        [
          beginKeywords,
          // do this later so compiler extensions that come earlier have access to the
          // raw array if they wanted to perhaps manipulate it, etc.
          compileIllegal,
          // default to 1 relevance if not specified
          compileRelevance
        ].forEach((ext) => ext(mode, parent));
        mode.isCompiled = true;
        let keywordPattern = null;
        if (typeof mode.keywords === "object" && mode.keywords.$pattern) {
          mode.keywords = Object.assign({}, mode.keywords);
          keywordPattern = mode.keywords.$pattern;
          delete mode.keywords.$pattern;
        }
        keywordPattern = keywordPattern || /\w+/;
        if (mode.keywords) {
          mode.keywords = compileKeywords(mode.keywords, language.case_insensitive);
        }
        cmode.keywordPatternRe = langRe(keywordPattern, true);
        if (parent) {
          if (!mode.begin) mode.begin = /\B|\b/;
          cmode.beginRe = langRe(cmode.begin);
          if (!mode.end && !mode.endsWithParent) mode.end = /\B|\b/;
          if (mode.end) cmode.endRe = langRe(cmode.end);
          cmode.terminatorEnd = source(cmode.end) || "";
          if (mode.endsWithParent && parent.terminatorEnd) {
            cmode.terminatorEnd += (mode.end ? "|" : "") + parent.terminatorEnd;
          }
        }
        if (mode.illegal) cmode.illegalRe = langRe(
          /** @type {RegExp | string} */
          mode.illegal
        );
        if (!mode.contains) mode.contains = [];
        mode.contains = [].concat(...mode.contains.map(function(c4) {
          return expandOrCloneMode(c4 === "self" ? mode : c4);
        }));
        mode.contains.forEach(function(c4) {
          compileMode(
            /** @type Mode */
            c4,
            cmode
          );
        });
        if (mode.starts) {
          compileMode(mode.starts, parent);
        }
        cmode.matcher = buildModeRegex(cmode);
        return cmode;
      }
      if (!language.compilerExtensions) language.compilerExtensions = [];
      if (language.contains && language.contains.includes("self")) {
        throw new Error("ERR: contains `self` is not supported at the top-level of a language.  See documentation.");
      }
      language.classNameAliases = inherit$1(language.classNameAliases || {});
      return compileMode(
        /** @type Mode */
        language
      );
    }
    function dependencyOnParent(mode) {
      if (!mode) return false;
      return mode.endsWithParent || dependencyOnParent(mode.starts);
    }
    function expandOrCloneMode(mode) {
      if (mode.variants && !mode.cachedVariants) {
        mode.cachedVariants = mode.variants.map(function(variant) {
          return inherit$1(mode, { variants: null }, variant);
        });
      }
      if (mode.cachedVariants) {
        return mode.cachedVariants;
      }
      if (dependencyOnParent(mode)) {
        return inherit$1(mode, { starts: mode.starts ? inherit$1(mode.starts) : null });
      }
      if (Object.isFrozen(mode)) {
        return inherit$1(mode);
      }
      return mode;
    }
    var version = "11.11.1";
    var HTMLInjectionError = class extends Error {
      constructor(reason, html) {
        super(reason);
        this.name = "HTMLInjectionError";
        this.html = html;
      }
    };
    var escape = escapeHTML;
    var inherit = inherit$1;
    var NO_MATCH = Symbol("nomatch");
    var MAX_KEYWORD_HITS = 7;
    var HLJS = function(hljs) {
      const languages = /* @__PURE__ */ Object.create(null);
      const aliases = /* @__PURE__ */ Object.create(null);
      const plugins = [];
      let SAFE_MODE = true;
      const LANGUAGE_NOT_FOUND = "Could not find the language '{}', did you forget to load/include a language module?";
      const PLAINTEXT_LANGUAGE = { disableAutodetect: true, name: "Plain text", contains: [] };
      let options = {
        ignoreUnescapedHTML: false,
        throwUnescapedHTML: false,
        noHighlightRe: /^(no-?highlight)$/i,
        languageDetectRe: /\blang(?:uage)?-([\w-]+)\b/i,
        classPrefix: "hljs-",
        cssSelector: "pre code",
        languages: null,
        // beta configuration options, subject to change, welcome to discuss
        // https://github.com/highlightjs/highlight.js/issues/1086
        __emitter: TokenTreeEmitter
      };
      function shouldNotHighlight(languageName) {
        return options.noHighlightRe.test(languageName);
      }
      function blockLanguage(block) {
        let classes = block.className + " ";
        classes += block.parentNode ? block.parentNode.className : "";
        const match2 = options.languageDetectRe.exec(classes);
        if (match2) {
          const language = getLanguage(match2[1]);
          if (!language) {
            warn(LANGUAGE_NOT_FOUND.replace("{}", match2[1]));
            warn("Falling back to no-highlight mode for this block.", block);
          }
          return language ? match2[1] : "no-highlight";
        }
        return classes.split(/\s+/).find((_class) => shouldNotHighlight(_class) || getLanguage(_class));
      }
      function highlight2(codeOrLanguageName, optionsOrCode, ignoreIllegals) {
        let code = "";
        let languageName = "";
        if (typeof optionsOrCode === "object") {
          code = codeOrLanguageName;
          ignoreIllegals = optionsOrCode.ignoreIllegals;
          languageName = optionsOrCode.language;
        } else {
          deprecated("10.7.0", "highlight(lang, code, ...args) has been deprecated.");
          deprecated("10.7.0", "Please use highlight(code, options) instead.\nhttps://github.com/highlightjs/highlight.js/issues/2277");
          languageName = codeOrLanguageName;
          code = optionsOrCode;
        }
        if (ignoreIllegals === void 0) {
          ignoreIllegals = true;
        }
        const context = {
          code,
          language: languageName
        };
        fire("before:highlight", context);
        const result = context.result ? context.result : _highlight(context.language, context.code, ignoreIllegals);
        result.code = context.code;
        fire("after:highlight", result);
        return result;
      }
      function _highlight(languageName, codeToHighlight, ignoreIllegals, continuation) {
        const keywordHits = /* @__PURE__ */ Object.create(null);
        function keywordData(mode, matchText) {
          return mode.keywords[matchText];
        }
        function processKeywords() {
          if (!top.keywords) {
            emitter.addText(modeBuffer);
            return;
          }
          let lastIndex = 0;
          top.keywordPatternRe.lastIndex = 0;
          let match2 = top.keywordPatternRe.exec(modeBuffer);
          let buf = "";
          while (match2) {
            buf += modeBuffer.substring(lastIndex, match2.index);
            const word = language.case_insensitive ? match2[0].toLowerCase() : match2[0];
            const data = keywordData(top, word);
            if (data) {
              const [kind, keywordRelevance] = data;
              emitter.addText(buf);
              buf = "";
              keywordHits[word] = (keywordHits[word] || 0) + 1;
              if (keywordHits[word] <= MAX_KEYWORD_HITS) relevance += keywordRelevance;
              if (kind.startsWith("_")) {
                buf += match2[0];
              } else {
                const cssClass = language.classNameAliases[kind] || kind;
                emitKeyword(match2[0], cssClass);
              }
            } else {
              buf += match2[0];
            }
            lastIndex = top.keywordPatternRe.lastIndex;
            match2 = top.keywordPatternRe.exec(modeBuffer);
          }
          buf += modeBuffer.substring(lastIndex);
          emitter.addText(buf);
        }
        function processSubLanguage() {
          if (modeBuffer === "") return;
          let result2 = null;
          if (typeof top.subLanguage === "string") {
            if (!languages[top.subLanguage]) {
              emitter.addText(modeBuffer);
              return;
            }
            result2 = _highlight(top.subLanguage, modeBuffer, true, continuations[top.subLanguage]);
            continuations[top.subLanguage] = /** @type {CompiledMode} */
            result2._top;
          } else {
            result2 = highlightAuto(modeBuffer, top.subLanguage.length ? top.subLanguage : null);
          }
          if (top.relevance > 0) {
            relevance += result2.relevance;
          }
          emitter.__addSublanguage(result2._emitter, result2.language);
        }
        function processBuffer() {
          if (top.subLanguage != null) {
            processSubLanguage();
          } else {
            processKeywords();
          }
          modeBuffer = "";
        }
        function emitKeyword(keyword, scope) {
          if (keyword === "") return;
          emitter.startScope(scope);
          emitter.addText(keyword);
          emitter.endScope();
        }
        function emitMultiClass(scope, match2) {
          let i5 = 1;
          const max = match2.length - 1;
          while (i5 <= max) {
            if (!scope._emit[i5]) {
              i5++;
              continue;
            }
            const klass = language.classNameAliases[scope[i5]] || scope[i5];
            const text = match2[i5];
            if (klass) {
              emitKeyword(text, klass);
            } else {
              modeBuffer = text;
              processKeywords();
              modeBuffer = "";
            }
            i5++;
          }
        }
        function startNewMode(mode, match2) {
          if (mode.scope && typeof mode.scope === "string") {
            emitter.openNode(language.classNameAliases[mode.scope] || mode.scope);
          }
          if (mode.beginScope) {
            if (mode.beginScope._wrap) {
              emitKeyword(modeBuffer, language.classNameAliases[mode.beginScope._wrap] || mode.beginScope._wrap);
              modeBuffer = "";
            } else if (mode.beginScope._multi) {
              emitMultiClass(mode.beginScope, match2);
              modeBuffer = "";
            }
          }
          top = Object.create(mode, { parent: { value: top } });
          return top;
        }
        function endOfMode(mode, match2, matchPlusRemainder) {
          let matched = startsWith(mode.endRe, matchPlusRemainder);
          if (matched) {
            if (mode["on:end"]) {
              const resp = new Response(mode);
              mode["on:end"](match2, resp);
              if (resp.isMatchIgnored) matched = false;
            }
            if (matched) {
              while (mode.endsParent && mode.parent) {
                mode = mode.parent;
              }
              return mode;
            }
          }
          if (mode.endsWithParent) {
            return endOfMode(mode.parent, match2, matchPlusRemainder);
          }
        }
        function doIgnore(lexeme) {
          if (top.matcher.regexIndex === 0) {
            modeBuffer += lexeme[0];
            return 1;
          } else {
            resumeScanAtSamePosition = true;
            return 0;
          }
        }
        function doBeginMatch(match2) {
          const lexeme = match2[0];
          const newMode = match2.rule;
          const resp = new Response(newMode);
          const beforeCallbacks = [newMode.__beforeBegin, newMode["on:begin"]];
          for (const cb of beforeCallbacks) {
            if (!cb) continue;
            cb(match2, resp);
            if (resp.isMatchIgnored) return doIgnore(lexeme);
          }
          if (newMode.skip) {
            modeBuffer += lexeme;
          } else {
            if (newMode.excludeBegin) {
              modeBuffer += lexeme;
            }
            processBuffer();
            if (!newMode.returnBegin && !newMode.excludeBegin) {
              modeBuffer = lexeme;
            }
          }
          startNewMode(newMode, match2);
          return newMode.returnBegin ? 0 : lexeme.length;
        }
        function doEndMatch(match2) {
          const lexeme = match2[0];
          const matchPlusRemainder = codeToHighlight.substring(match2.index);
          const endMode = endOfMode(top, match2, matchPlusRemainder);
          if (!endMode) {
            return NO_MATCH;
          }
          const origin = top;
          if (top.endScope && top.endScope._wrap) {
            processBuffer();
            emitKeyword(lexeme, top.endScope._wrap);
          } else if (top.endScope && top.endScope._multi) {
            processBuffer();
            emitMultiClass(top.endScope, match2);
          } else if (origin.skip) {
            modeBuffer += lexeme;
          } else {
            if (!(origin.returnEnd || origin.excludeEnd)) {
              modeBuffer += lexeme;
            }
            processBuffer();
            if (origin.excludeEnd) {
              modeBuffer = lexeme;
            }
          }
          do {
            if (top.scope) {
              emitter.closeNode();
            }
            if (!top.skip && !top.subLanguage) {
              relevance += top.relevance;
            }
            top = top.parent;
          } while (top !== endMode.parent);
          if (endMode.starts) {
            startNewMode(endMode.starts, match2);
          }
          return origin.returnEnd ? 0 : lexeme.length;
        }
        function processContinuations() {
          const list = [];
          for (let current = top; current !== language; current = current.parent) {
            if (current.scope) {
              list.unshift(current.scope);
            }
          }
          list.forEach((item) => emitter.openNode(item));
        }
        let lastMatch = {};
        function processLexeme(textBeforeMatch, match2) {
          const lexeme = match2 && match2[0];
          modeBuffer += textBeforeMatch;
          if (lexeme == null) {
            processBuffer();
            return 0;
          }
          if (lastMatch.type === "begin" && match2.type === "end" && lastMatch.index === match2.index && lexeme === "") {
            modeBuffer += codeToHighlight.slice(match2.index, match2.index + 1);
            if (!SAFE_MODE) {
              const err = new Error(`0 width match regex (${languageName})`);
              err.languageName = languageName;
              err.badRule = lastMatch.rule;
              throw err;
            }
            return 1;
          }
          lastMatch = match2;
          if (match2.type === "begin") {
            return doBeginMatch(match2);
          } else if (match2.type === "illegal" && !ignoreIllegals) {
            const err = new Error('Illegal lexeme "' + lexeme + '" for mode "' + (top.scope || "<unnamed>") + '"');
            err.mode = top;
            throw err;
          } else if (match2.type === "end") {
            const processed = doEndMatch(match2);
            if (processed !== NO_MATCH) {
              return processed;
            }
          }
          if (match2.type === "illegal" && lexeme === "") {
            modeBuffer += "\n";
            return 1;
          }
          if (iterations > 1e5 && iterations > match2.index * 3) {
            const err = new Error("potential infinite loop, way more iterations than matches");
            throw err;
          }
          modeBuffer += lexeme;
          return lexeme.length;
        }
        const language = getLanguage(languageName);
        if (!language) {
          error(LANGUAGE_NOT_FOUND.replace("{}", languageName));
          throw new Error('Unknown language: "' + languageName + '"');
        }
        const md = compileLanguage(language);
        let result = "";
        let top = continuation || md;
        const continuations = {};
        const emitter = new options.__emitter(options);
        processContinuations();
        let modeBuffer = "";
        let relevance = 0;
        let index = 0;
        let iterations = 0;
        let resumeScanAtSamePosition = false;
        try {
          if (!language.__emitTokens) {
            top.matcher.considerAll();
            for (; ; ) {
              iterations++;
              if (resumeScanAtSamePosition) {
                resumeScanAtSamePosition = false;
              } else {
                top.matcher.considerAll();
              }
              top.matcher.lastIndex = index;
              const match2 = top.matcher.exec(codeToHighlight);
              if (!match2) break;
              const beforeMatch = codeToHighlight.substring(index, match2.index);
              const processedCount = processLexeme(beforeMatch, match2);
              index = match2.index + processedCount;
            }
            processLexeme(codeToHighlight.substring(index));
          } else {
            language.__emitTokens(codeToHighlight, emitter);
          }
          emitter.finalize();
          result = emitter.toHTML();
          return {
            language: languageName,
            value: result,
            relevance,
            illegal: false,
            _emitter: emitter,
            _top: top
          };
        } catch (err) {
          if (err.message && err.message.includes("Illegal")) {
            return {
              language: languageName,
              value: escape(codeToHighlight),
              illegal: true,
              relevance: 0,
              _illegalBy: {
                message: err.message,
                index,
                context: codeToHighlight.slice(index - 100, index + 100),
                mode: err.mode,
                resultSoFar: result
              },
              _emitter: emitter
            };
          } else if (SAFE_MODE) {
            return {
              language: languageName,
              value: escape(codeToHighlight),
              illegal: false,
              relevance: 0,
              errorRaised: err,
              _emitter: emitter,
              _top: top
            };
          } else {
            throw err;
          }
        }
      }
      function justTextHighlightResult(code) {
        const result = {
          value: escape(code),
          illegal: false,
          relevance: 0,
          _top: PLAINTEXT_LANGUAGE,
          _emitter: new options.__emitter(options)
        };
        result._emitter.addText(code);
        return result;
      }
      function highlightAuto(code, languageSubset) {
        languageSubset = languageSubset || options.languages || Object.keys(languages);
        const plaintext = justTextHighlightResult(code);
        const results = languageSubset.filter(getLanguage).filter(autoDetection).map(
          (name) => _highlight(name, code, false)
        );
        results.unshift(plaintext);
        const sorted = results.sort((a4, b5) => {
          if (a4.relevance !== b5.relevance) return b5.relevance - a4.relevance;
          if (a4.language && b5.language) {
            if (getLanguage(a4.language).supersetOf === b5.language) {
              return 1;
            } else if (getLanguage(b5.language).supersetOf === a4.language) {
              return -1;
            }
          }
          return 0;
        });
        const [best, secondBest] = sorted;
        const result = best;
        result.secondBest = secondBest;
        return result;
      }
      function updateClassName(element, currentLang, resultLang) {
        const language = currentLang && aliases[currentLang] || resultLang;
        element.classList.add("hljs");
        element.classList.add(`language-${language}`);
      }
      function highlightElement(element) {
        let node = null;
        const language = blockLanguage(element);
        if (shouldNotHighlight(language)) return;
        fire(
          "before:highlightElement",
          { el: element, language }
        );
        if (element.dataset.highlighted) {
          console.log("Element previously highlighted. To highlight again, first unset `dataset.highlighted`.", element);
          return;
        }
        if (element.children.length > 0) {
          if (!options.ignoreUnescapedHTML) {
            console.warn("One of your code blocks includes unescaped HTML. This is a potentially serious security risk.");
            console.warn("https://github.com/highlightjs/highlight.js/wiki/security");
            console.warn("The element with unescaped HTML:");
            console.warn(element);
          }
          if (options.throwUnescapedHTML) {
            const err = new HTMLInjectionError(
              "One of your code blocks includes unescaped HTML.",
              element.innerHTML
            );
            throw err;
          }
        }
        node = element;
        const text = node.textContent;
        const result = language ? highlight2(text, { language, ignoreIllegals: true }) : highlightAuto(text);
        element.innerHTML = result.value;
        element.dataset.highlighted = "yes";
        updateClassName(element, language, result.language);
        element.result = {
          language: result.language,
          // TODO: remove with version 11.0
          re: result.relevance,
          relevance: result.relevance
        };
        if (result.secondBest) {
          element.secondBest = {
            language: result.secondBest.language,
            relevance: result.secondBest.relevance
          };
        }
        fire("after:highlightElement", { el: element, result, text });
      }
      function configure(userOptions) {
        options = inherit(options, userOptions);
      }
      const initHighlighting = () => {
        highlightAll();
        deprecated("10.6.0", "initHighlighting() deprecated.  Use highlightAll() now.");
      };
      function initHighlightingOnLoad() {
        highlightAll();
        deprecated("10.6.0", "initHighlightingOnLoad() deprecated.  Use highlightAll() now.");
      }
      let wantsHighlight = false;
      function highlightAll() {
        function boot() {
          highlightAll();
        }
        if (document.readyState === "loading") {
          if (!wantsHighlight) {
            window.addEventListener("DOMContentLoaded", boot, false);
          }
          wantsHighlight = true;
          return;
        }
        const blocks = document.querySelectorAll(options.cssSelector);
        blocks.forEach(highlightElement);
      }
      function registerLanguage(languageName, languageDefinition) {
        let lang = null;
        try {
          lang = languageDefinition(hljs);
        } catch (error$1) {
          error("Language definition for '{}' could not be registered.".replace("{}", languageName));
          if (!SAFE_MODE) {
            throw error$1;
          } else {
            error(error$1);
          }
          lang = PLAINTEXT_LANGUAGE;
        }
        if (!lang.name) lang.name = languageName;
        languages[languageName] = lang;
        lang.rawDefinition = languageDefinition.bind(null, hljs);
        if (lang.aliases) {
          registerAliases(lang.aliases, { languageName });
        }
      }
      function unregisterLanguage(languageName) {
        delete languages[languageName];
        for (const alias of Object.keys(aliases)) {
          if (aliases[alias] === languageName) {
            delete aliases[alias];
          }
        }
      }
      function listLanguages() {
        return Object.keys(languages);
      }
      function getLanguage(name) {
        name = (name || "").toLowerCase();
        return languages[name] || languages[aliases[name]];
      }
      function registerAliases(aliasList, { languageName }) {
        if (typeof aliasList === "string") {
          aliasList = [aliasList];
        }
        aliasList.forEach((alias) => {
          aliases[alias.toLowerCase()] = languageName;
        });
      }
      function autoDetection(name) {
        const lang = getLanguage(name);
        return lang && !lang.disableAutodetect;
      }
      function upgradePluginAPI(plugin) {
        if (plugin["before:highlightBlock"] && !plugin["before:highlightElement"]) {
          plugin["before:highlightElement"] = (data) => {
            plugin["before:highlightBlock"](
              Object.assign({ block: data.el }, data)
            );
          };
        }
        if (plugin["after:highlightBlock"] && !plugin["after:highlightElement"]) {
          plugin["after:highlightElement"] = (data) => {
            plugin["after:highlightBlock"](
              Object.assign({ block: data.el }, data)
            );
          };
        }
      }
      function addPlugin(plugin) {
        upgradePluginAPI(plugin);
        plugins.push(plugin);
      }
      function removePlugin(plugin) {
        const index = plugins.indexOf(plugin);
        if (index !== -1) {
          plugins.splice(index, 1);
        }
      }
      function fire(event, args) {
        const cb = event;
        plugins.forEach(function(plugin) {
          if (plugin[cb]) {
            plugin[cb](args);
          }
        });
      }
      function deprecateHighlightBlock(el) {
        deprecated("10.7.0", "highlightBlock will be removed entirely in v12.0");
        deprecated("10.7.0", "Please use highlightElement now.");
        return highlightElement(el);
      }
      Object.assign(hljs, {
        highlight: highlight2,
        highlightAuto,
        highlightAll,
        highlightElement,
        // TODO: Remove with v12 API
        highlightBlock: deprecateHighlightBlock,
        configure,
        initHighlighting,
        initHighlightingOnLoad,
        registerLanguage,
        unregisterLanguage,
        listLanguages,
        getLanguage,
        registerAliases,
        autoDetection,
        inherit,
        addPlugin,
        removePlugin
      });
      hljs.debugMode = function() {
        SAFE_MODE = false;
      };
      hljs.safeMode = function() {
        SAFE_MODE = true;
      };
      hljs.versionString = version;
      hljs.regex = {
        concat,
        lookahead,
        either,
        optional,
        anyNumberOfTimes
      };
      for (const key in MODES) {
        if (typeof MODES[key] === "object") {
          deepFreeze(MODES[key]);
        }
      }
      Object.assign(hljs, MODES);
      return hljs;
    };
    var highlight = HLJS({});
    highlight.newInstance = () => HLJS({});
    module.exports = highlight;
    highlight.HighlightJS = highlight;
    highlight.default = highlight;
  }
});

// node_modules/highlight.js/lib/languages/xml.js
var require_xml = __commonJS({
  "node_modules/highlight.js/lib/languages/xml.js"(exports, module) {
    function xml(hljs) {
      const regex = hljs.regex;
      const TAG_NAME_RE = regex.concat(/[\p{L}_]/u, regex.optional(/[\p{L}0-9_.-]*:/u), /[\p{L}0-9_.-]*/u);
      const XML_IDENT_RE = /[\p{L}0-9._:-]+/u;
      const XML_ENTITIES = {
        className: "symbol",
        begin: /&[a-z]+;|&#[0-9]+;|&#x[a-f0-9]+;/
      };
      const XML_META_KEYWORDS = {
        begin: /\s/,
        contains: [
          {
            className: "keyword",
            begin: /#?[a-z_][a-z1-9_-]+/,
            illegal: /\n/
          }
        ]
      };
      const XML_META_PAR_KEYWORDS = hljs.inherit(XML_META_KEYWORDS, {
        begin: /\(/,
        end: /\)/
      });
      const APOS_META_STRING_MODE = hljs.inherit(hljs.APOS_STRING_MODE, { className: "string" });
      const QUOTE_META_STRING_MODE = hljs.inherit(hljs.QUOTE_STRING_MODE, { className: "string" });
      const TAG_INTERNALS = {
        endsWithParent: true,
        illegal: /</,
        relevance: 0,
        contains: [
          {
            className: "attr",
            begin: XML_IDENT_RE,
            relevance: 0
          },
          {
            begin: /=\s*/,
            relevance: 0,
            contains: [
              {
                className: "string",
                endsParent: true,
                variants: [
                  {
                    begin: /"/,
                    end: /"/,
                    contains: [XML_ENTITIES]
                  },
                  {
                    begin: /'/,
                    end: /'/,
                    contains: [XML_ENTITIES]
                  },
                  { begin: /[^\s"'=<>`]+/ }
                ]
              }
            ]
          }
        ]
      };
      return {
        name: "HTML, XML",
        aliases: [
          "html",
          "xhtml",
          "rss",
          "atom",
          "xjb",
          "xsd",
          "xsl",
          "plist",
          "wsf",
          "svg"
        ],
        case_insensitive: true,
        unicodeRegex: true,
        contains: [
          {
            className: "meta",
            begin: /<![a-z]/,
            end: />/,
            relevance: 10,
            contains: [
              XML_META_KEYWORDS,
              QUOTE_META_STRING_MODE,
              APOS_META_STRING_MODE,
              XML_META_PAR_KEYWORDS,
              {
                begin: /\[/,
                end: /\]/,
                contains: [
                  {
                    className: "meta",
                    begin: /<![a-z]/,
                    end: />/,
                    contains: [
                      XML_META_KEYWORDS,
                      XML_META_PAR_KEYWORDS,
                      QUOTE_META_STRING_MODE,
                      APOS_META_STRING_MODE
                    ]
                  }
                ]
              }
            ]
          },
          hljs.COMMENT(
            /<!--/,
            /-->/,
            { relevance: 10 }
          ),
          {
            begin: /<!\[CDATA\[/,
            end: /\]\]>/,
            relevance: 10
          },
          XML_ENTITIES,
          // xml processing instructions
          {
            className: "meta",
            end: /\?>/,
            variants: [
              {
                begin: /<\?xml/,
                relevance: 10,
                contains: [
                  QUOTE_META_STRING_MODE
                ]
              },
              {
                begin: /<\?[a-z][a-z0-9]+/
              }
            ]
          },
          {
            className: "tag",
            /*
            The lookahead pattern (?=...) ensures that 'begin' only matches
            '<style' as a single word, followed by a whitespace or an
            ending bracket.
            */
            begin: /<style(?=\s|>)/,
            end: />/,
            keywords: { name: "style" },
            contains: [TAG_INTERNALS],
            starts: {
              end: /<\/style>/,
              returnEnd: true,
              subLanguage: [
                "css",
                "xml"
              ]
            }
          },
          {
            className: "tag",
            // See the comment in the <style tag about the lookahead pattern
            begin: /<script(?=\s|>)/,
            end: />/,
            keywords: { name: "script" },
            contains: [TAG_INTERNALS],
            starts: {
              end: /<\/script>/,
              returnEnd: true,
              subLanguage: [
                "javascript",
                "handlebars",
                "xml"
              ]
            }
          },
          // we need this for now for jSX
          {
            className: "tag",
            begin: /<>|<\/>/
          },
          // open tag
          {
            className: "tag",
            begin: regex.concat(
              /</,
              regex.lookahead(regex.concat(
                TAG_NAME_RE,
                // <tag/>
                // <tag>
                // <tag ...
                regex.either(/\/>/, />/, /\s/)
              ))
            ),
            end: /\/?>/,
            contains: [
              {
                className: "name",
                begin: TAG_NAME_RE,
                relevance: 0,
                starts: TAG_INTERNALS
              }
            ]
          },
          // close tag
          {
            className: "tag",
            begin: regex.concat(
              /<\//,
              regex.lookahead(regex.concat(
                TAG_NAME_RE,
                />/
              ))
            ),
            contains: [
              {
                className: "name",
                begin: TAG_NAME_RE,
                relevance: 0
              },
              {
                begin: />/,
                relevance: 0,
                endsParent: true
              }
            ]
          }
        ]
      };
    }
    module.exports = xml;
  }
});

// node_modules/highlight.js/lib/languages/bash.js
var require_bash = __commonJS({
  "node_modules/highlight.js/lib/languages/bash.js"(exports, module) {
    function bash(hljs) {
      const regex = hljs.regex;
      const VAR = {};
      const BRACED_VAR = {
        begin: /\$\{/,
        end: /\}/,
        contains: [
          "self",
          {
            begin: /:-/,
            contains: [VAR]
          }
          // default values
        ]
      };
      Object.assign(VAR, {
        className: "variable",
        variants: [
          { begin: regex.concat(
            /\$[\w\d#@][\w\d_]*/,
            // negative look-ahead tries to avoid matching patterns that are not
            // Perl at all like $ident$, @ident@, etc.
            `(?![\\w\\d])(?![$])`
          ) },
          BRACED_VAR
        ]
      });
      const SUBST = {
        className: "subst",
        begin: /\$\(/,
        end: /\)/,
        contains: [hljs.BACKSLASH_ESCAPE]
      };
      const COMMENT = hljs.inherit(
        hljs.COMMENT(),
        {
          match: [
            /(^|\s)/,
            /#.*$/
          ],
          scope: {
            2: "comment"
          }
        }
      );
      const HERE_DOC = {
        begin: /<<-?\s*(?=\w+)/,
        starts: { contains: [
          hljs.END_SAME_AS_BEGIN({
            begin: /(\w+)/,
            end: /(\w+)/,
            className: "string"
          })
        ] }
      };
      const QUOTE_STRING = {
        className: "string",
        begin: /"/,
        end: /"/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          VAR,
          SUBST
        ]
      };
      SUBST.contains.push(QUOTE_STRING);
      const ESCAPED_QUOTE = {
        match: /\\"/
      };
      const APOS_STRING = {
        className: "string",
        begin: /'/,
        end: /'/
      };
      const ESCAPED_APOS = {
        match: /\\'/
      };
      const ARITHMETIC = {
        begin: /\$?\(\(/,
        end: /\)\)/,
        contains: [
          {
            begin: /\d+#[0-9a-f]+/,
            className: "number"
          },
          hljs.NUMBER_MODE,
          VAR
        ]
      };
      const SH_LIKE_SHELLS = [
        "fish",
        "bash",
        "zsh",
        "sh",
        "csh",
        "ksh",
        "tcsh",
        "dash",
        "scsh"
      ];
      const KNOWN_SHEBANG = hljs.SHEBANG({
        binary: `(${SH_LIKE_SHELLS.join("|")})`,
        relevance: 10
      });
      const FUNCTION = {
        className: "function",
        begin: /\w[\w\d_]*\s*\(\s*\)\s*\{/,
        returnBegin: true,
        contains: [hljs.inherit(hljs.TITLE_MODE, { begin: /\w[\w\d_]*/ })],
        relevance: 0
      };
      const KEYWORDS = [
        "if",
        "then",
        "else",
        "elif",
        "fi",
        "time",
        "for",
        "while",
        "until",
        "in",
        "do",
        "done",
        "case",
        "esac",
        "coproc",
        "function",
        "select"
      ];
      const LITERALS = [
        "true",
        "false"
      ];
      const PATH_MODE = { match: /(\/[a-z._-]+)+/ };
      const SHELL_BUILT_INS = [
        "break",
        "cd",
        "continue",
        "eval",
        "exec",
        "exit",
        "export",
        "getopts",
        "hash",
        "pwd",
        "readonly",
        "return",
        "shift",
        "test",
        "times",
        "trap",
        "umask",
        "unset"
      ];
      const BASH_BUILT_INS = [
        "alias",
        "bind",
        "builtin",
        "caller",
        "command",
        "declare",
        "echo",
        "enable",
        "help",
        "let",
        "local",
        "logout",
        "mapfile",
        "printf",
        "read",
        "readarray",
        "source",
        "sudo",
        "type",
        "typeset",
        "ulimit",
        "unalias"
      ];
      const ZSH_BUILT_INS = [
        "autoload",
        "bg",
        "bindkey",
        "bye",
        "cap",
        "chdir",
        "clone",
        "comparguments",
        "compcall",
        "compctl",
        "compdescribe",
        "compfiles",
        "compgroups",
        "compquote",
        "comptags",
        "comptry",
        "compvalues",
        "dirs",
        "disable",
        "disown",
        "echotc",
        "echoti",
        "emulate",
        "fc",
        "fg",
        "float",
        "functions",
        "getcap",
        "getln",
        "history",
        "integer",
        "jobs",
        "kill",
        "limit",
        "log",
        "noglob",
        "popd",
        "print",
        "pushd",
        "pushln",
        "rehash",
        "sched",
        "setcap",
        "setopt",
        "stat",
        "suspend",
        "ttyctl",
        "unfunction",
        "unhash",
        "unlimit",
        "unsetopt",
        "vared",
        "wait",
        "whence",
        "where",
        "which",
        "zcompile",
        "zformat",
        "zftp",
        "zle",
        "zmodload",
        "zparseopts",
        "zprof",
        "zpty",
        "zregexparse",
        "zsocket",
        "zstyle",
        "ztcp"
      ];
      const GNU_CORE_UTILS = [
        "chcon",
        "chgrp",
        "chown",
        "chmod",
        "cp",
        "dd",
        "df",
        "dir",
        "dircolors",
        "ln",
        "ls",
        "mkdir",
        "mkfifo",
        "mknod",
        "mktemp",
        "mv",
        "realpath",
        "rm",
        "rmdir",
        "shred",
        "sync",
        "touch",
        "truncate",
        "vdir",
        "b2sum",
        "base32",
        "base64",
        "cat",
        "cksum",
        "comm",
        "csplit",
        "cut",
        "expand",
        "fmt",
        "fold",
        "head",
        "join",
        "md5sum",
        "nl",
        "numfmt",
        "od",
        "paste",
        "ptx",
        "pr",
        "sha1sum",
        "sha224sum",
        "sha256sum",
        "sha384sum",
        "sha512sum",
        "shuf",
        "sort",
        "split",
        "sum",
        "tac",
        "tail",
        "tr",
        "tsort",
        "unexpand",
        "uniq",
        "wc",
        "arch",
        "basename",
        "chroot",
        "date",
        "dirname",
        "du",
        "echo",
        "env",
        "expr",
        "factor",
        // "false", // keyword literal already
        "groups",
        "hostid",
        "id",
        "link",
        "logname",
        "nice",
        "nohup",
        "nproc",
        "pathchk",
        "pinky",
        "printenv",
        "printf",
        "pwd",
        "readlink",
        "runcon",
        "seq",
        "sleep",
        "stat",
        "stdbuf",
        "stty",
        "tee",
        "test",
        "timeout",
        // "true", // keyword literal already
        "tty",
        "uname",
        "unlink",
        "uptime",
        "users",
        "who",
        "whoami",
        "yes"
      ];
      return {
        name: "Bash",
        aliases: [
          "sh",
          "zsh"
        ],
        keywords: {
          $pattern: /\b[a-z][a-z0-9._-]+\b/,
          keyword: KEYWORDS,
          literal: LITERALS,
          built_in: [
            ...SHELL_BUILT_INS,
            ...BASH_BUILT_INS,
            // Shell modifiers
            "set",
            "shopt",
            ...ZSH_BUILT_INS,
            ...GNU_CORE_UTILS
          ]
        },
        contains: [
          KNOWN_SHEBANG,
          // to catch known shells and boost relevancy
          hljs.SHEBANG(),
          // to catch unknown shells but still highlight the shebang
          FUNCTION,
          ARITHMETIC,
          COMMENT,
          HERE_DOC,
          PATH_MODE,
          QUOTE_STRING,
          ESCAPED_QUOTE,
          APOS_STRING,
          ESCAPED_APOS,
          VAR
        ]
      };
    }
    module.exports = bash;
  }
});

// node_modules/highlight.js/lib/languages/c.js
var require_c = __commonJS({
  "node_modules/highlight.js/lib/languages/c.js"(exports, module) {
    function c4(hljs) {
      const regex = hljs.regex;
      const C_LINE_COMMENT_MODE = hljs.COMMENT("//", "$", { contains: [{ begin: /\\\n/ }] });
      const DECLTYPE_AUTO_RE = "decltype\\(auto\\)";
      const NAMESPACE_RE = "[a-zA-Z_]\\w*::";
      const TEMPLATE_ARGUMENT_RE = "<[^<>]+>";
      const FUNCTION_TYPE_RE = "(" + DECLTYPE_AUTO_RE + "|" + regex.optional(NAMESPACE_RE) + "[a-zA-Z_]\\w*" + regex.optional(TEMPLATE_ARGUMENT_RE) + ")";
      const TYPES = {
        className: "type",
        variants: [
          { begin: "\\b[a-z\\d_]*_t\\b" },
          { match: /\batomic_[a-z]{3,6}\b/ }
        ]
      };
      const CHARACTER_ESCAPES = "\\\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4,8}|[0-7]{3}|\\S)";
      const STRINGS = {
        className: "string",
        variants: [
          {
            begin: '(u8?|U|L)?"',
            end: '"',
            illegal: "\\n",
            contains: [hljs.BACKSLASH_ESCAPE]
          },
          {
            begin: "(u8?|U|L)?'(" + CHARACTER_ESCAPES + "|.)",
            end: "'",
            illegal: "."
          },
          hljs.END_SAME_AS_BEGIN({
            begin: /(?:u8?|U|L)?R"([^()\\ ]{0,16})\(/,
            end: /\)([^()\\ ]{0,16})"/
          })
        ]
      };
      const NUMBERS = {
        className: "number",
        variants: [
          { match: /\b(0b[01']+)/ },
          { match: /(-?)\b([\d']+(\.[\d']*)?|\.[\d']+)((ll|LL|l|L)(u|U)?|(u|U)(ll|LL|l|L)?|f|F|b|B)/ },
          { match: /(-?)\b(0[xX][a-fA-F0-9]+(?:'[a-fA-F0-9]+)*(?:\.[a-fA-F0-9]*(?:'[a-fA-F0-9]*)*)?(?:[pP][-+]?[0-9]+)?(l|L)?(u|U)?)/ },
          { match: /(-?)\b\d+(?:'\d+)*(?:\.\d*(?:'\d*)*)?(?:[eE][-+]?\d+)?/ }
        ],
        relevance: 0
      };
      const PREPROCESSOR = {
        className: "meta",
        begin: /#\s*[a-z]+\b/,
        end: /$/,
        keywords: { keyword: "if else elif endif define undef warning error line pragma _Pragma ifdef ifndef elifdef elifndef include" },
        contains: [
          {
            begin: /\\\n/,
            relevance: 0
          },
          hljs.inherit(STRINGS, { className: "string" }),
          {
            className: "string",
            begin: /<.*?>/
          },
          C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ]
      };
      const TITLE_MODE = {
        className: "title",
        begin: regex.optional(NAMESPACE_RE) + hljs.IDENT_RE,
        relevance: 0
      };
      const FUNCTION_TITLE = regex.optional(NAMESPACE_RE) + hljs.IDENT_RE + "\\s*\\(";
      const C_KEYWORDS = [
        "asm",
        "auto",
        "break",
        "case",
        "continue",
        "default",
        "do",
        "else",
        "enum",
        "extern",
        "for",
        "fortran",
        "goto",
        "if",
        "inline",
        "register",
        "restrict",
        "return",
        "sizeof",
        "typeof",
        "typeof_unqual",
        "struct",
        "switch",
        "typedef",
        "union",
        "volatile",
        "while",
        "_Alignas",
        "_Alignof",
        "_Atomic",
        "_Generic",
        "_Noreturn",
        "_Static_assert",
        "_Thread_local",
        // aliases
        "alignas",
        "alignof",
        "noreturn",
        "static_assert",
        "thread_local",
        // not a C keyword but is, for all intents and purposes, treated exactly like one.
        "_Pragma"
      ];
      const C_TYPES = [
        "float",
        "double",
        "signed",
        "unsigned",
        "int",
        "short",
        "long",
        "char",
        "void",
        "_Bool",
        "_BitInt",
        "_Complex",
        "_Imaginary",
        "_Decimal32",
        "_Decimal64",
        "_Decimal96",
        "_Decimal128",
        "_Decimal64x",
        "_Decimal128x",
        "_Float16",
        "_Float32",
        "_Float64",
        "_Float128",
        "_Float32x",
        "_Float64x",
        "_Float128x",
        // modifiers
        "const",
        "static",
        "constexpr",
        // aliases
        "complex",
        "bool",
        "imaginary"
      ];
      const KEYWORDS = {
        keyword: C_KEYWORDS,
        type: C_TYPES,
        literal: "true false NULL",
        // TODO: apply hinting work similar to what was done in cpp.js
        built_in: "std string wstring cin cout cerr clog stdin stdout stderr stringstream istringstream ostringstream auto_ptr deque list queue stack vector map set pair bitset multiset multimap unordered_set unordered_map unordered_multiset unordered_multimap priority_queue make_pair array shared_ptr abort terminate abs acos asin atan2 atan calloc ceil cosh cos exit exp fabs floor fmod fprintf fputs free frexp fscanf future isalnum isalpha iscntrl isdigit isgraph islower isprint ispunct isspace isupper isxdigit tolower toupper labs ldexp log10 log malloc realloc memchr memcmp memcpy memset modf pow printf putchar puts scanf sinh sin snprintf sprintf sqrt sscanf strcat strchr strcmp strcpy strcspn strlen strncat strncmp strncpy strpbrk strrchr strspn strstr tanh tan vfprintf vprintf vsprintf endl initializer_list unique_ptr"
      };
      const EXPRESSION_CONTAINS = [
        PREPROCESSOR,
        TYPES,
        C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        NUMBERS,
        STRINGS
      ];
      const EXPRESSION_CONTEXT = {
        // This mode covers expression context where we can't expect a function
        // definition and shouldn't highlight anything that looks like one:
        // `return some()`, `else if()`, `(x*sum(1, 2))`
        variants: [
          {
            begin: /=/,
            end: /;/
          },
          {
            begin: /\(/,
            end: /\)/
          },
          {
            beginKeywords: "new throw return else",
            end: /;/
          }
        ],
        keywords: KEYWORDS,
        contains: EXPRESSION_CONTAINS.concat([
          {
            begin: /\(/,
            end: /\)/,
            keywords: KEYWORDS,
            contains: EXPRESSION_CONTAINS.concat(["self"]),
            relevance: 0
          }
        ]),
        relevance: 0
      };
      const FUNCTION_DECLARATION = {
        begin: "(" + FUNCTION_TYPE_RE + "[\\*&\\s]+)+" + FUNCTION_TITLE,
        returnBegin: true,
        end: /[{;=]/,
        excludeEnd: true,
        keywords: KEYWORDS,
        illegal: /[^\w\s\*&:<>.]/,
        contains: [
          {
            // to prevent it from being confused as the function title
            begin: DECLTYPE_AUTO_RE,
            keywords: KEYWORDS,
            relevance: 0
          },
          {
            begin: FUNCTION_TITLE,
            returnBegin: true,
            contains: [hljs.inherit(TITLE_MODE, { className: "title.function" })],
            relevance: 0
          },
          // allow for multiple declarations, e.g.:
          // extern void f(int), g(char);
          {
            relevance: 0,
            match: /,/
          },
          {
            className: "params",
            begin: /\(/,
            end: /\)/,
            keywords: KEYWORDS,
            relevance: 0,
            contains: [
              C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE,
              STRINGS,
              NUMBERS,
              TYPES,
              // Count matching parentheses.
              {
                begin: /\(/,
                end: /\)/,
                keywords: KEYWORDS,
                relevance: 0,
                contains: [
                  "self",
                  C_LINE_COMMENT_MODE,
                  hljs.C_BLOCK_COMMENT_MODE,
                  STRINGS,
                  NUMBERS,
                  TYPES
                ]
              }
            ]
          },
          TYPES,
          C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          PREPROCESSOR
        ]
      };
      return {
        name: "C",
        aliases: ["h"],
        keywords: KEYWORDS,
        // Until differentiations are added between `c` and `cpp`, `c` will
        // not be auto-detected to avoid auto-detect conflicts between C and C++
        disableAutodetect: true,
        illegal: "</",
        contains: [].concat(
          EXPRESSION_CONTEXT,
          FUNCTION_DECLARATION,
          EXPRESSION_CONTAINS,
          [
            PREPROCESSOR,
            {
              begin: hljs.IDENT_RE + "::",
              keywords: KEYWORDS
            },
            {
              className: "class",
              beginKeywords: "enum class struct union",
              end: /[{;:<>=]/,
              contains: [
                { beginKeywords: "final class struct" },
                hljs.TITLE_MODE
              ]
            }
          ]
        ),
        exports: {
          preprocessor: PREPROCESSOR,
          strings: STRINGS,
          keywords: KEYWORDS
        }
      };
    }
    module.exports = c4;
  }
});

// node_modules/highlight.js/lib/languages/cpp.js
var require_cpp = __commonJS({
  "node_modules/highlight.js/lib/languages/cpp.js"(exports, module) {
    function cpp(hljs) {
      const regex = hljs.regex;
      const C_LINE_COMMENT_MODE = hljs.COMMENT("//", "$", { contains: [{ begin: /\\\n/ }] });
      const DECLTYPE_AUTO_RE = "decltype\\(auto\\)";
      const NAMESPACE_RE = "[a-zA-Z_]\\w*::";
      const TEMPLATE_ARGUMENT_RE = "<[^<>]+>";
      const FUNCTION_TYPE_RE = "(?!struct)(" + DECLTYPE_AUTO_RE + "|" + regex.optional(NAMESPACE_RE) + "[a-zA-Z_]\\w*" + regex.optional(TEMPLATE_ARGUMENT_RE) + ")";
      const CPP_PRIMITIVE_TYPES = {
        className: "type",
        begin: "\\b[a-z\\d_]*_t\\b"
      };
      const CHARACTER_ESCAPES = "\\\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4,8}|[0-7]{3}|\\S)";
      const STRINGS = {
        className: "string",
        variants: [
          {
            begin: '(u8?|U|L)?"',
            end: '"',
            illegal: "\\n",
            contains: [hljs.BACKSLASH_ESCAPE]
          },
          {
            begin: "(u8?|U|L)?'(" + CHARACTER_ESCAPES + "|.)",
            end: "'",
            illegal: "."
          },
          hljs.END_SAME_AS_BEGIN({
            begin: /(?:u8?|U|L)?R"([^()\\ ]{0,16})\(/,
            end: /\)([^()\\ ]{0,16})"/
          })
        ]
      };
      const NUMBERS = {
        className: "number",
        variants: [
          // Floating-point literal.
          {
            begin: "[+-]?(?:(?:[0-9](?:'?[0-9])*\\.(?:[0-9](?:'?[0-9])*)?|\\.[0-9](?:'?[0-9])*)(?:[Ee][+-]?[0-9](?:'?[0-9])*)?|[0-9](?:'?[0-9])*[Ee][+-]?[0-9](?:'?[0-9])*|0[Xx](?:[0-9A-Fa-f](?:'?[0-9A-Fa-f])*(?:\\.(?:[0-9A-Fa-f](?:'?[0-9A-Fa-f])*)?)?|\\.[0-9A-Fa-f](?:'?[0-9A-Fa-f])*)[Pp][+-]?[0-9](?:'?[0-9])*)(?:[Ff](?:16|32|64|128)?|(BF|bf)16|[Ll]|)"
          },
          // Integer literal.
          {
            begin: "[+-]?\\b(?:0[Bb][01](?:'?[01])*|0[Xx][0-9A-Fa-f](?:'?[0-9A-Fa-f])*|0(?:'?[0-7])*|[1-9](?:'?[0-9])*)(?:[Uu](?:LL?|ll?)|[Uu][Zz]?|(?:LL?|ll?)[Uu]?|[Zz][Uu]|)"
            // Note: there are user-defined literal suffixes too, but perhaps having the custom suffix not part of the
            // literal highlight actually makes it stand out more.
          }
        ],
        relevance: 0
      };
      const PREPROCESSOR = {
        className: "meta",
        begin: /#\s*[a-z]+\b/,
        end: /$/,
        keywords: { keyword: "if else elif endif define undef warning error line pragma _Pragma ifdef ifndef include" },
        contains: [
          {
            begin: /\\\n/,
            relevance: 0
          },
          hljs.inherit(STRINGS, { className: "string" }),
          {
            className: "string",
            begin: /<.*?>/
          },
          C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ]
      };
      const TITLE_MODE = {
        className: "title",
        begin: regex.optional(NAMESPACE_RE) + hljs.IDENT_RE,
        relevance: 0
      };
      const FUNCTION_TITLE = regex.optional(NAMESPACE_RE) + hljs.IDENT_RE + "\\s*\\(";
      const RESERVED_KEYWORDS = [
        "alignas",
        "alignof",
        "and",
        "and_eq",
        "asm",
        "atomic_cancel",
        "atomic_commit",
        "atomic_noexcept",
        "auto",
        "bitand",
        "bitor",
        "break",
        "case",
        "catch",
        "class",
        "co_await",
        "co_return",
        "co_yield",
        "compl",
        "concept",
        "const_cast|10",
        "consteval",
        "constexpr",
        "constinit",
        "continue",
        "decltype",
        "default",
        "delete",
        "do",
        "dynamic_cast|10",
        "else",
        "enum",
        "explicit",
        "export",
        "extern",
        "false",
        "final",
        "for",
        "friend",
        "goto",
        "if",
        "import",
        "inline",
        "module",
        "mutable",
        "namespace",
        "new",
        "noexcept",
        "not",
        "not_eq",
        "nullptr",
        "operator",
        "or",
        "or_eq",
        "override",
        "private",
        "protected",
        "public",
        "reflexpr",
        "register",
        "reinterpret_cast|10",
        "requires",
        "return",
        "sizeof",
        "static_assert",
        "static_cast|10",
        "struct",
        "switch",
        "synchronized",
        "template",
        "this",
        "thread_local",
        "throw",
        "transaction_safe",
        "transaction_safe_dynamic",
        "true",
        "try",
        "typedef",
        "typeid",
        "typename",
        "union",
        "using",
        "virtual",
        "volatile",
        "while",
        "xor",
        "xor_eq"
      ];
      const RESERVED_TYPES = [
        "bool",
        "char",
        "char16_t",
        "char32_t",
        "char8_t",
        "double",
        "float",
        "int",
        "long",
        "short",
        "void",
        "wchar_t",
        "unsigned",
        "signed",
        "const",
        "static"
      ];
      const TYPE_HINTS = [
        "any",
        "auto_ptr",
        "barrier",
        "binary_semaphore",
        "bitset",
        "complex",
        "condition_variable",
        "condition_variable_any",
        "counting_semaphore",
        "deque",
        "false_type",
        "flat_map",
        "flat_set",
        "future",
        "imaginary",
        "initializer_list",
        "istringstream",
        "jthread",
        "latch",
        "lock_guard",
        "multimap",
        "multiset",
        "mutex",
        "optional",
        "ostringstream",
        "packaged_task",
        "pair",
        "promise",
        "priority_queue",
        "queue",
        "recursive_mutex",
        "recursive_timed_mutex",
        "scoped_lock",
        "set",
        "shared_future",
        "shared_lock",
        "shared_mutex",
        "shared_timed_mutex",
        "shared_ptr",
        "stack",
        "string_view",
        "stringstream",
        "timed_mutex",
        "thread",
        "true_type",
        "tuple",
        "unique_lock",
        "unique_ptr",
        "unordered_map",
        "unordered_multimap",
        "unordered_multiset",
        "unordered_set",
        "variant",
        "vector",
        "weak_ptr",
        "wstring",
        "wstring_view"
      ];
      const FUNCTION_HINTS = [
        "abort",
        "abs",
        "acos",
        "apply",
        "as_const",
        "asin",
        "atan",
        "atan2",
        "calloc",
        "ceil",
        "cerr",
        "cin",
        "clog",
        "cos",
        "cosh",
        "cout",
        "declval",
        "endl",
        "exchange",
        "exit",
        "exp",
        "fabs",
        "floor",
        "fmod",
        "forward",
        "fprintf",
        "fputs",
        "free",
        "frexp",
        "fscanf",
        "future",
        "invoke",
        "isalnum",
        "isalpha",
        "iscntrl",
        "isdigit",
        "isgraph",
        "islower",
        "isprint",
        "ispunct",
        "isspace",
        "isupper",
        "isxdigit",
        "labs",
        "launder",
        "ldexp",
        "log",
        "log10",
        "make_pair",
        "make_shared",
        "make_shared_for_overwrite",
        "make_tuple",
        "make_unique",
        "malloc",
        "memchr",
        "memcmp",
        "memcpy",
        "memset",
        "modf",
        "move",
        "pow",
        "printf",
        "putchar",
        "puts",
        "realloc",
        "scanf",
        "sin",
        "sinh",
        "snprintf",
        "sprintf",
        "sqrt",
        "sscanf",
        "std",
        "stderr",
        "stdin",
        "stdout",
        "strcat",
        "strchr",
        "strcmp",
        "strcpy",
        "strcspn",
        "strlen",
        "strncat",
        "strncmp",
        "strncpy",
        "strpbrk",
        "strrchr",
        "strspn",
        "strstr",
        "swap",
        "tan",
        "tanh",
        "terminate",
        "to_underlying",
        "tolower",
        "toupper",
        "vfprintf",
        "visit",
        "vprintf",
        "vsprintf"
      ];
      const LITERALS = [
        "NULL",
        "false",
        "nullopt",
        "nullptr",
        "true"
      ];
      const BUILT_IN = ["_Pragma"];
      const CPP_KEYWORDS = {
        type: RESERVED_TYPES,
        keyword: RESERVED_KEYWORDS,
        literal: LITERALS,
        built_in: BUILT_IN,
        _type_hints: TYPE_HINTS
      };
      const FUNCTION_DISPATCH = {
        className: "function.dispatch",
        relevance: 0,
        keywords: {
          // Only for relevance, not highlighting.
          _hint: FUNCTION_HINTS
        },
        begin: regex.concat(
          /\b/,
          /(?!decltype)/,
          /(?!if)/,
          /(?!for)/,
          /(?!switch)/,
          /(?!while)/,
          hljs.IDENT_RE,
          regex.lookahead(/(<[^<>]+>|)\s*\(/)
        )
      };
      const EXPRESSION_CONTAINS = [
        FUNCTION_DISPATCH,
        PREPROCESSOR,
        CPP_PRIMITIVE_TYPES,
        C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        NUMBERS,
        STRINGS
      ];
      const EXPRESSION_CONTEXT = {
        // This mode covers expression context where we can't expect a function
        // definition and shouldn't highlight anything that looks like one:
        // `return some()`, `else if()`, `(x*sum(1, 2))`
        variants: [
          {
            begin: /=/,
            end: /;/
          },
          {
            begin: /\(/,
            end: /\)/
          },
          {
            beginKeywords: "new throw return else",
            end: /;/
          }
        ],
        keywords: CPP_KEYWORDS,
        contains: EXPRESSION_CONTAINS.concat([
          {
            begin: /\(/,
            end: /\)/,
            keywords: CPP_KEYWORDS,
            contains: EXPRESSION_CONTAINS.concat(["self"]),
            relevance: 0
          }
        ]),
        relevance: 0
      };
      const FUNCTION_DECLARATION = {
        className: "function",
        begin: "(" + FUNCTION_TYPE_RE + "[\\*&\\s]+)+" + FUNCTION_TITLE,
        returnBegin: true,
        end: /[{;=]/,
        excludeEnd: true,
        keywords: CPP_KEYWORDS,
        illegal: /[^\w\s\*&:<>.]/,
        contains: [
          {
            // to prevent it from being confused as the function title
            begin: DECLTYPE_AUTO_RE,
            keywords: CPP_KEYWORDS,
            relevance: 0
          },
          {
            begin: FUNCTION_TITLE,
            returnBegin: true,
            contains: [TITLE_MODE],
            relevance: 0
          },
          // needed because we do not have look-behind on the below rule
          // to prevent it from grabbing the final : in a :: pair
          {
            begin: /::/,
            relevance: 0
          },
          // initializers
          {
            begin: /:/,
            endsWithParent: true,
            contains: [
              STRINGS,
              NUMBERS
            ]
          },
          // allow for multiple declarations, e.g.:
          // extern void f(int), g(char);
          {
            relevance: 0,
            match: /,/
          },
          {
            className: "params",
            begin: /\(/,
            end: /\)/,
            keywords: CPP_KEYWORDS,
            relevance: 0,
            contains: [
              C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE,
              STRINGS,
              NUMBERS,
              CPP_PRIMITIVE_TYPES,
              // Count matching parentheses.
              {
                begin: /\(/,
                end: /\)/,
                keywords: CPP_KEYWORDS,
                relevance: 0,
                contains: [
                  "self",
                  C_LINE_COMMENT_MODE,
                  hljs.C_BLOCK_COMMENT_MODE,
                  STRINGS,
                  NUMBERS,
                  CPP_PRIMITIVE_TYPES
                ]
              }
            ]
          },
          CPP_PRIMITIVE_TYPES,
          C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          PREPROCESSOR
        ]
      };
      return {
        name: "C++",
        aliases: [
          "cc",
          "c++",
          "h++",
          "hpp",
          "hh",
          "hxx",
          "cxx"
        ],
        keywords: CPP_KEYWORDS,
        illegal: "</",
        classNameAliases: { "function.dispatch": "built_in" },
        contains: [].concat(
          EXPRESSION_CONTEXT,
          FUNCTION_DECLARATION,
          FUNCTION_DISPATCH,
          EXPRESSION_CONTAINS,
          [
            PREPROCESSOR,
            {
              // containers: ie, `vector <int> rooms (9);`
              begin: "\\b(deque|list|queue|priority_queue|pair|stack|vector|map|set|bitset|multiset|multimap|unordered_map|unordered_set|unordered_multiset|unordered_multimap|array|tuple|optional|variant|function|flat_map|flat_set)\\s*<(?!<)",
              end: ">",
              keywords: CPP_KEYWORDS,
              contains: [
                "self",
                CPP_PRIMITIVE_TYPES
              ]
            },
            {
              begin: hljs.IDENT_RE + "::",
              keywords: CPP_KEYWORDS
            },
            {
              match: [
                // extra complexity to deal with `enum class` and `enum struct`
                /\b(?:enum(?:\s+(?:class|struct))?|class|struct|union)/,
                /\s+/,
                /\w+/
              ],
              className: {
                1: "keyword",
                3: "title.class"
              }
            }
          ]
        )
      };
    }
    module.exports = cpp;
  }
});

// node_modules/highlight.js/lib/languages/csharp.js
var require_csharp = __commonJS({
  "node_modules/highlight.js/lib/languages/csharp.js"(exports, module) {
    function csharp(hljs) {
      const BUILT_IN_KEYWORDS = [
        "bool",
        "byte",
        "char",
        "decimal",
        "delegate",
        "double",
        "dynamic",
        "enum",
        "float",
        "int",
        "long",
        "nint",
        "nuint",
        "object",
        "sbyte",
        "short",
        "string",
        "ulong",
        "uint",
        "ushort"
      ];
      const FUNCTION_MODIFIERS = [
        "public",
        "private",
        "protected",
        "static",
        "internal",
        "protected",
        "abstract",
        "async",
        "extern",
        "override",
        "unsafe",
        "virtual",
        "new",
        "sealed",
        "partial"
      ];
      const LITERAL_KEYWORDS = [
        "default",
        "false",
        "null",
        "true"
      ];
      const NORMAL_KEYWORDS = [
        "abstract",
        "as",
        "base",
        "break",
        "case",
        "catch",
        "class",
        "const",
        "continue",
        "do",
        "else",
        "event",
        "explicit",
        "extern",
        "finally",
        "fixed",
        "for",
        "foreach",
        "goto",
        "if",
        "implicit",
        "in",
        "interface",
        "internal",
        "is",
        "lock",
        "namespace",
        "new",
        "operator",
        "out",
        "override",
        "params",
        "private",
        "protected",
        "public",
        "readonly",
        "record",
        "ref",
        "return",
        "scoped",
        "sealed",
        "sizeof",
        "stackalloc",
        "static",
        "struct",
        "switch",
        "this",
        "throw",
        "try",
        "typeof",
        "unchecked",
        "unsafe",
        "using",
        "virtual",
        "void",
        "volatile",
        "while"
      ];
      const CONTEXTUAL_KEYWORDS = [
        "add",
        "alias",
        "and",
        "ascending",
        "args",
        "async",
        "await",
        "by",
        "descending",
        "dynamic",
        "equals",
        "file",
        "from",
        "get",
        "global",
        "group",
        "init",
        "into",
        "join",
        "let",
        "nameof",
        "not",
        "notnull",
        "on",
        "or",
        "orderby",
        "partial",
        "record",
        "remove",
        "required",
        "scoped",
        "select",
        "set",
        "unmanaged",
        "value|0",
        "var",
        "when",
        "where",
        "with",
        "yield"
      ];
      const KEYWORDS = {
        keyword: NORMAL_KEYWORDS.concat(CONTEXTUAL_KEYWORDS),
        built_in: BUILT_IN_KEYWORDS,
        literal: LITERAL_KEYWORDS
      };
      const TITLE_MODE = hljs.inherit(hljs.TITLE_MODE, { begin: "[a-zA-Z](\\.?\\w)*" });
      const NUMBERS = {
        className: "number",
        variants: [
          { begin: "\\b(0b[01']+)" },
          { begin: "(-?)\\b([\\d']+(\\.[\\d']*)?|\\.[\\d']+)(u|U|l|L|ul|UL|f|F|b|B)" },
          { begin: "(-?)(\\b0[xX][a-fA-F0-9']+|(\\b[\\d']+(\\.[\\d']*)?|\\.[\\d']+)([eE][-+]?[\\d']+)?)" }
        ],
        relevance: 0
      };
      const RAW_STRING = {
        className: "string",
        begin: /"""("*)(?!")(.|\n)*?"""\1/,
        relevance: 1
      };
      const VERBATIM_STRING = {
        className: "string",
        begin: '@"',
        end: '"',
        contains: [{ begin: '""' }]
      };
      const VERBATIM_STRING_NO_LF = hljs.inherit(VERBATIM_STRING, { illegal: /\n/ });
      const SUBST = {
        className: "subst",
        begin: /\{/,
        end: /\}/,
        keywords: KEYWORDS
      };
      const SUBST_NO_LF = hljs.inherit(SUBST, { illegal: /\n/ });
      const INTERPOLATED_STRING = {
        className: "string",
        begin: /\$"/,
        end: '"',
        illegal: /\n/,
        contains: [
          { begin: /\{\{/ },
          { begin: /\}\}/ },
          hljs.BACKSLASH_ESCAPE,
          SUBST_NO_LF
        ]
      };
      const INTERPOLATED_VERBATIM_STRING = {
        className: "string",
        begin: /\$@"/,
        end: '"',
        contains: [
          { begin: /\{\{/ },
          { begin: /\}\}/ },
          { begin: '""' },
          SUBST
        ]
      };
      const INTERPOLATED_VERBATIM_STRING_NO_LF = hljs.inherit(INTERPOLATED_VERBATIM_STRING, {
        illegal: /\n/,
        contains: [
          { begin: /\{\{/ },
          { begin: /\}\}/ },
          { begin: '""' },
          SUBST_NO_LF
        ]
      });
      SUBST.contains = [
        INTERPOLATED_VERBATIM_STRING,
        INTERPOLATED_STRING,
        VERBATIM_STRING,
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE,
        NUMBERS,
        hljs.C_BLOCK_COMMENT_MODE
      ];
      SUBST_NO_LF.contains = [
        INTERPOLATED_VERBATIM_STRING_NO_LF,
        INTERPOLATED_STRING,
        VERBATIM_STRING_NO_LF,
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE,
        NUMBERS,
        hljs.inherit(hljs.C_BLOCK_COMMENT_MODE, { illegal: /\n/ })
      ];
      const STRING = { variants: [
        RAW_STRING,
        INTERPOLATED_VERBATIM_STRING,
        INTERPOLATED_STRING,
        VERBATIM_STRING,
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE
      ] };
      const GENERIC_MODIFIER = {
        begin: "<",
        end: ">",
        contains: [
          { beginKeywords: "in out" },
          TITLE_MODE
        ]
      };
      const TYPE_IDENT_RE = hljs.IDENT_RE + "(<" + hljs.IDENT_RE + "(\\s*,\\s*" + hljs.IDENT_RE + ")*>)?(\\[\\])?";
      const AT_IDENTIFIER = {
        // prevents expressions like `@class` from incorrect flagging
        // `class` as a keyword
        begin: "@" + hljs.IDENT_RE,
        relevance: 0
      };
      return {
        name: "C#",
        aliases: [
          "cs",
          "c#"
        ],
        keywords: KEYWORDS,
        illegal: /::/,
        contains: [
          hljs.COMMENT(
            "///",
            "$",
            {
              returnBegin: true,
              contains: [
                {
                  className: "doctag",
                  variants: [
                    {
                      begin: "///",
                      relevance: 0
                    },
                    { begin: "<!--|-->" },
                    {
                      begin: "</?",
                      end: ">"
                    }
                  ]
                }
              ]
            }
          ),
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          {
            className: "meta",
            begin: "#",
            end: "$",
            keywords: { keyword: "if else elif endif define undef warning error line region endregion pragma checksum" }
          },
          STRING,
          NUMBERS,
          {
            beginKeywords: "class interface",
            relevance: 0,
            end: /[{;=]/,
            illegal: /[^\s:,]/,
            contains: [
              { beginKeywords: "where class" },
              TITLE_MODE,
              GENERIC_MODIFIER,
              hljs.C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE
            ]
          },
          {
            beginKeywords: "namespace",
            relevance: 0,
            end: /[{;=]/,
            illegal: /[^\s:]/,
            contains: [
              TITLE_MODE,
              hljs.C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE
            ]
          },
          {
            beginKeywords: "record",
            relevance: 0,
            end: /[{;=]/,
            illegal: /[^\s:]/,
            contains: [
              TITLE_MODE,
              GENERIC_MODIFIER,
              hljs.C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE
            ]
          },
          {
            // [Attributes("")]
            className: "meta",
            begin: "^\\s*\\[(?=[\\w])",
            excludeBegin: true,
            end: "\\]",
            excludeEnd: true,
            contains: [
              {
                className: "string",
                begin: /"/,
                end: /"/
              }
            ]
          },
          {
            // Expression keywords prevent 'keyword Name(...)' from being
            // recognized as a function definition
            beginKeywords: "new return throw await else",
            relevance: 0
          },
          {
            className: "function",
            begin: "(" + TYPE_IDENT_RE + "\\s+)+" + hljs.IDENT_RE + "\\s*(<[^=]+>\\s*)?\\(",
            returnBegin: true,
            end: /\s*[{;=]/,
            excludeEnd: true,
            keywords: KEYWORDS,
            contains: [
              // prevents these from being highlighted `title`
              {
                beginKeywords: FUNCTION_MODIFIERS.join(" "),
                relevance: 0
              },
              {
                begin: hljs.IDENT_RE + "\\s*(<[^=]+>\\s*)?\\(",
                returnBegin: true,
                contains: [
                  hljs.TITLE_MODE,
                  GENERIC_MODIFIER
                ],
                relevance: 0
              },
              { match: /\(\)/ },
              {
                className: "params",
                begin: /\(/,
                end: /\)/,
                excludeBegin: true,
                excludeEnd: true,
                keywords: KEYWORDS,
                relevance: 0,
                contains: [
                  STRING,
                  NUMBERS,
                  hljs.C_BLOCK_COMMENT_MODE
                ]
              },
              hljs.C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE
            ]
          },
          AT_IDENTIFIER
        ]
      };
    }
    module.exports = csharp;
  }
});

// node_modules/highlight.js/lib/languages/css.js
var require_css = __commonJS({
  "node_modules/highlight.js/lib/languages/css.js"(exports, module) {
    var MODES = (hljs) => {
      return {
        IMPORTANT: {
          scope: "meta",
          begin: "!important"
        },
        BLOCK_COMMENT: hljs.C_BLOCK_COMMENT_MODE,
        HEXCOLOR: {
          scope: "number",
          begin: /#(([0-9a-fA-F]{3,4})|(([0-9a-fA-F]{2}){3,4}))\b/
        },
        FUNCTION_DISPATCH: {
          className: "built_in",
          begin: /[\w-]+(?=\()/
        },
        ATTRIBUTE_SELECTOR_MODE: {
          scope: "selector-attr",
          begin: /\[/,
          end: /\]/,
          illegal: "$",
          contains: [
            hljs.APOS_STRING_MODE,
            hljs.QUOTE_STRING_MODE
          ]
        },
        CSS_NUMBER_MODE: {
          scope: "number",
          begin: hljs.NUMBER_RE + "(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
          relevance: 0
        },
        CSS_VARIABLE: {
          className: "attr",
          begin: /--[A-Za-z_][A-Za-z0-9_-]*/
        }
      };
    };
    var HTML_TAGS = [
      "a",
      "abbr",
      "address",
      "article",
      "aside",
      "audio",
      "b",
      "blockquote",
      "body",
      "button",
      "canvas",
      "caption",
      "cite",
      "code",
      "dd",
      "del",
      "details",
      "dfn",
      "div",
      "dl",
      "dt",
      "em",
      "fieldset",
      "figcaption",
      "figure",
      "footer",
      "form",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hgroup",
      "html",
      "i",
      "iframe",
      "img",
      "input",
      "ins",
      "kbd",
      "label",
      "legend",
      "li",
      "main",
      "mark",
      "menu",
      "nav",
      "object",
      "ol",
      "optgroup",
      "option",
      "p",
      "picture",
      "q",
      "quote",
      "samp",
      "section",
      "select",
      "source",
      "span",
      "strong",
      "summary",
      "sup",
      "table",
      "tbody",
      "td",
      "textarea",
      "tfoot",
      "th",
      "thead",
      "time",
      "tr",
      "ul",
      "var",
      "video"
    ];
    var SVG_TAGS = [
      "defs",
      "g",
      "marker",
      "mask",
      "pattern",
      "svg",
      "switch",
      "symbol",
      "feBlend",
      "feColorMatrix",
      "feComponentTransfer",
      "feComposite",
      "feConvolveMatrix",
      "feDiffuseLighting",
      "feDisplacementMap",
      "feFlood",
      "feGaussianBlur",
      "feImage",
      "feMerge",
      "feMorphology",
      "feOffset",
      "feSpecularLighting",
      "feTile",
      "feTurbulence",
      "linearGradient",
      "radialGradient",
      "stop",
      "circle",
      "ellipse",
      "image",
      "line",
      "path",
      "polygon",
      "polyline",
      "rect",
      "text",
      "use",
      "textPath",
      "tspan",
      "foreignObject",
      "clipPath"
    ];
    var TAGS = [
      ...HTML_TAGS,
      ...SVG_TAGS
    ];
    var MEDIA_FEATURES = [
      "any-hover",
      "any-pointer",
      "aspect-ratio",
      "color",
      "color-gamut",
      "color-index",
      "device-aspect-ratio",
      "device-height",
      "device-width",
      "display-mode",
      "forced-colors",
      "grid",
      "height",
      "hover",
      "inverted-colors",
      "monochrome",
      "orientation",
      "overflow-block",
      "overflow-inline",
      "pointer",
      "prefers-color-scheme",
      "prefers-contrast",
      "prefers-reduced-motion",
      "prefers-reduced-transparency",
      "resolution",
      "scan",
      "scripting",
      "update",
      "width",
      // TODO: find a better solution?
      "min-width",
      "max-width",
      "min-height",
      "max-height"
    ].sort().reverse();
    var PSEUDO_CLASSES = [
      "active",
      "any-link",
      "blank",
      "checked",
      "current",
      "default",
      "defined",
      "dir",
      // dir()
      "disabled",
      "drop",
      "empty",
      "enabled",
      "first",
      "first-child",
      "first-of-type",
      "fullscreen",
      "future",
      "focus",
      "focus-visible",
      "focus-within",
      "has",
      // has()
      "host",
      // host or host()
      "host-context",
      // host-context()
      "hover",
      "indeterminate",
      "in-range",
      "invalid",
      "is",
      // is()
      "lang",
      // lang()
      "last-child",
      "last-of-type",
      "left",
      "link",
      "local-link",
      "not",
      // not()
      "nth-child",
      // nth-child()
      "nth-col",
      // nth-col()
      "nth-last-child",
      // nth-last-child()
      "nth-last-col",
      // nth-last-col()
      "nth-last-of-type",
      //nth-last-of-type()
      "nth-of-type",
      //nth-of-type()
      "only-child",
      "only-of-type",
      "optional",
      "out-of-range",
      "past",
      "placeholder-shown",
      "read-only",
      "read-write",
      "required",
      "right",
      "root",
      "scope",
      "target",
      "target-within",
      "user-invalid",
      "valid",
      "visited",
      "where"
      // where()
    ].sort().reverse();
    var PSEUDO_ELEMENTS = [
      "after",
      "backdrop",
      "before",
      "cue",
      "cue-region",
      "first-letter",
      "first-line",
      "grammar-error",
      "marker",
      "part",
      "placeholder",
      "selection",
      "slotted",
      "spelling-error"
    ].sort().reverse();
    var ATTRIBUTES = [
      "accent-color",
      "align-content",
      "align-items",
      "align-self",
      "alignment-baseline",
      "all",
      "anchor-name",
      "animation",
      "animation-composition",
      "animation-delay",
      "animation-direction",
      "animation-duration",
      "animation-fill-mode",
      "animation-iteration-count",
      "animation-name",
      "animation-play-state",
      "animation-range",
      "animation-range-end",
      "animation-range-start",
      "animation-timeline",
      "animation-timing-function",
      "appearance",
      "aspect-ratio",
      "backdrop-filter",
      "backface-visibility",
      "background",
      "background-attachment",
      "background-blend-mode",
      "background-clip",
      "background-color",
      "background-image",
      "background-origin",
      "background-position",
      "background-position-x",
      "background-position-y",
      "background-repeat",
      "background-size",
      "baseline-shift",
      "block-size",
      "border",
      "border-block",
      "border-block-color",
      "border-block-end",
      "border-block-end-color",
      "border-block-end-style",
      "border-block-end-width",
      "border-block-start",
      "border-block-start-color",
      "border-block-start-style",
      "border-block-start-width",
      "border-block-style",
      "border-block-width",
      "border-bottom",
      "border-bottom-color",
      "border-bottom-left-radius",
      "border-bottom-right-radius",
      "border-bottom-style",
      "border-bottom-width",
      "border-collapse",
      "border-color",
      "border-end-end-radius",
      "border-end-start-radius",
      "border-image",
      "border-image-outset",
      "border-image-repeat",
      "border-image-slice",
      "border-image-source",
      "border-image-width",
      "border-inline",
      "border-inline-color",
      "border-inline-end",
      "border-inline-end-color",
      "border-inline-end-style",
      "border-inline-end-width",
      "border-inline-start",
      "border-inline-start-color",
      "border-inline-start-style",
      "border-inline-start-width",
      "border-inline-style",
      "border-inline-width",
      "border-left",
      "border-left-color",
      "border-left-style",
      "border-left-width",
      "border-radius",
      "border-right",
      "border-right-color",
      "border-right-style",
      "border-right-width",
      "border-spacing",
      "border-start-end-radius",
      "border-start-start-radius",
      "border-style",
      "border-top",
      "border-top-color",
      "border-top-left-radius",
      "border-top-right-radius",
      "border-top-style",
      "border-top-width",
      "border-width",
      "bottom",
      "box-align",
      "box-decoration-break",
      "box-direction",
      "box-flex",
      "box-flex-group",
      "box-lines",
      "box-ordinal-group",
      "box-orient",
      "box-pack",
      "box-shadow",
      "box-sizing",
      "break-after",
      "break-before",
      "break-inside",
      "caption-side",
      "caret-color",
      "clear",
      "clip",
      "clip-path",
      "clip-rule",
      "color",
      "color-interpolation",
      "color-interpolation-filters",
      "color-profile",
      "color-rendering",
      "color-scheme",
      "column-count",
      "column-fill",
      "column-gap",
      "column-rule",
      "column-rule-color",
      "column-rule-style",
      "column-rule-width",
      "column-span",
      "column-width",
      "columns",
      "contain",
      "contain-intrinsic-block-size",
      "contain-intrinsic-height",
      "contain-intrinsic-inline-size",
      "contain-intrinsic-size",
      "contain-intrinsic-width",
      "container",
      "container-name",
      "container-type",
      "content",
      "content-visibility",
      "counter-increment",
      "counter-reset",
      "counter-set",
      "cue",
      "cue-after",
      "cue-before",
      "cursor",
      "cx",
      "cy",
      "direction",
      "display",
      "dominant-baseline",
      "empty-cells",
      "enable-background",
      "field-sizing",
      "fill",
      "fill-opacity",
      "fill-rule",
      "filter",
      "flex",
      "flex-basis",
      "flex-direction",
      "flex-flow",
      "flex-grow",
      "flex-shrink",
      "flex-wrap",
      "float",
      "flood-color",
      "flood-opacity",
      "flow",
      "font",
      "font-display",
      "font-family",
      "font-feature-settings",
      "font-kerning",
      "font-language-override",
      "font-optical-sizing",
      "font-palette",
      "font-size",
      "font-size-adjust",
      "font-smooth",
      "font-smoothing",
      "font-stretch",
      "font-style",
      "font-synthesis",
      "font-synthesis-position",
      "font-synthesis-small-caps",
      "font-synthesis-style",
      "font-synthesis-weight",
      "font-variant",
      "font-variant-alternates",
      "font-variant-caps",
      "font-variant-east-asian",
      "font-variant-emoji",
      "font-variant-ligatures",
      "font-variant-numeric",
      "font-variant-position",
      "font-variation-settings",
      "font-weight",
      "forced-color-adjust",
      "gap",
      "glyph-orientation-horizontal",
      "glyph-orientation-vertical",
      "grid",
      "grid-area",
      "grid-auto-columns",
      "grid-auto-flow",
      "grid-auto-rows",
      "grid-column",
      "grid-column-end",
      "grid-column-start",
      "grid-gap",
      "grid-row",
      "grid-row-end",
      "grid-row-start",
      "grid-template",
      "grid-template-areas",
      "grid-template-columns",
      "grid-template-rows",
      "hanging-punctuation",
      "height",
      "hyphenate-character",
      "hyphenate-limit-chars",
      "hyphens",
      "icon",
      "image-orientation",
      "image-rendering",
      "image-resolution",
      "ime-mode",
      "initial-letter",
      "initial-letter-align",
      "inline-size",
      "inset",
      "inset-area",
      "inset-block",
      "inset-block-end",
      "inset-block-start",
      "inset-inline",
      "inset-inline-end",
      "inset-inline-start",
      "isolation",
      "justify-content",
      "justify-items",
      "justify-self",
      "kerning",
      "left",
      "letter-spacing",
      "lighting-color",
      "line-break",
      "line-height",
      "line-height-step",
      "list-style",
      "list-style-image",
      "list-style-position",
      "list-style-type",
      "margin",
      "margin-block",
      "margin-block-end",
      "margin-block-start",
      "margin-bottom",
      "margin-inline",
      "margin-inline-end",
      "margin-inline-start",
      "margin-left",
      "margin-right",
      "margin-top",
      "margin-trim",
      "marker",
      "marker-end",
      "marker-mid",
      "marker-start",
      "marks",
      "mask",
      "mask-border",
      "mask-border-mode",
      "mask-border-outset",
      "mask-border-repeat",
      "mask-border-slice",
      "mask-border-source",
      "mask-border-width",
      "mask-clip",
      "mask-composite",
      "mask-image",
      "mask-mode",
      "mask-origin",
      "mask-position",
      "mask-repeat",
      "mask-size",
      "mask-type",
      "masonry-auto-flow",
      "math-depth",
      "math-shift",
      "math-style",
      "max-block-size",
      "max-height",
      "max-inline-size",
      "max-width",
      "min-block-size",
      "min-height",
      "min-inline-size",
      "min-width",
      "mix-blend-mode",
      "nav-down",
      "nav-index",
      "nav-left",
      "nav-right",
      "nav-up",
      "none",
      "normal",
      "object-fit",
      "object-position",
      "offset",
      "offset-anchor",
      "offset-distance",
      "offset-path",
      "offset-position",
      "offset-rotate",
      "opacity",
      "order",
      "orphans",
      "outline",
      "outline-color",
      "outline-offset",
      "outline-style",
      "outline-width",
      "overflow",
      "overflow-anchor",
      "overflow-block",
      "overflow-clip-margin",
      "overflow-inline",
      "overflow-wrap",
      "overflow-x",
      "overflow-y",
      "overlay",
      "overscroll-behavior",
      "overscroll-behavior-block",
      "overscroll-behavior-inline",
      "overscroll-behavior-x",
      "overscroll-behavior-y",
      "padding",
      "padding-block",
      "padding-block-end",
      "padding-block-start",
      "padding-bottom",
      "padding-inline",
      "padding-inline-end",
      "padding-inline-start",
      "padding-left",
      "padding-right",
      "padding-top",
      "page",
      "page-break-after",
      "page-break-before",
      "page-break-inside",
      "paint-order",
      "pause",
      "pause-after",
      "pause-before",
      "perspective",
      "perspective-origin",
      "place-content",
      "place-items",
      "place-self",
      "pointer-events",
      "position",
      "position-anchor",
      "position-visibility",
      "print-color-adjust",
      "quotes",
      "r",
      "resize",
      "rest",
      "rest-after",
      "rest-before",
      "right",
      "rotate",
      "row-gap",
      "ruby-align",
      "ruby-position",
      "scale",
      "scroll-behavior",
      "scroll-margin",
      "scroll-margin-block",
      "scroll-margin-block-end",
      "scroll-margin-block-start",
      "scroll-margin-bottom",
      "scroll-margin-inline",
      "scroll-margin-inline-end",
      "scroll-margin-inline-start",
      "scroll-margin-left",
      "scroll-margin-right",
      "scroll-margin-top",
      "scroll-padding",
      "scroll-padding-block",
      "scroll-padding-block-end",
      "scroll-padding-block-start",
      "scroll-padding-bottom",
      "scroll-padding-inline",
      "scroll-padding-inline-end",
      "scroll-padding-inline-start",
      "scroll-padding-left",
      "scroll-padding-right",
      "scroll-padding-top",
      "scroll-snap-align",
      "scroll-snap-stop",
      "scroll-snap-type",
      "scroll-timeline",
      "scroll-timeline-axis",
      "scroll-timeline-name",
      "scrollbar-color",
      "scrollbar-gutter",
      "scrollbar-width",
      "shape-image-threshold",
      "shape-margin",
      "shape-outside",
      "shape-rendering",
      "speak",
      "speak-as",
      "src",
      // @font-face
      "stop-color",
      "stop-opacity",
      "stroke",
      "stroke-dasharray",
      "stroke-dashoffset",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-miterlimit",
      "stroke-opacity",
      "stroke-width",
      "tab-size",
      "table-layout",
      "text-align",
      "text-align-all",
      "text-align-last",
      "text-anchor",
      "text-combine-upright",
      "text-decoration",
      "text-decoration-color",
      "text-decoration-line",
      "text-decoration-skip",
      "text-decoration-skip-ink",
      "text-decoration-style",
      "text-decoration-thickness",
      "text-emphasis",
      "text-emphasis-color",
      "text-emphasis-position",
      "text-emphasis-style",
      "text-indent",
      "text-justify",
      "text-orientation",
      "text-overflow",
      "text-rendering",
      "text-shadow",
      "text-size-adjust",
      "text-transform",
      "text-underline-offset",
      "text-underline-position",
      "text-wrap",
      "text-wrap-mode",
      "text-wrap-style",
      "timeline-scope",
      "top",
      "touch-action",
      "transform",
      "transform-box",
      "transform-origin",
      "transform-style",
      "transition",
      "transition-behavior",
      "transition-delay",
      "transition-duration",
      "transition-property",
      "transition-timing-function",
      "translate",
      "unicode-bidi",
      "user-modify",
      "user-select",
      "vector-effect",
      "vertical-align",
      "view-timeline",
      "view-timeline-axis",
      "view-timeline-inset",
      "view-timeline-name",
      "view-transition-name",
      "visibility",
      "voice-balance",
      "voice-duration",
      "voice-family",
      "voice-pitch",
      "voice-range",
      "voice-rate",
      "voice-stress",
      "voice-volume",
      "white-space",
      "white-space-collapse",
      "widows",
      "width",
      "will-change",
      "word-break",
      "word-spacing",
      "word-wrap",
      "writing-mode",
      "x",
      "y",
      "z-index",
      "zoom"
    ].sort().reverse();
    function css(hljs) {
      const regex = hljs.regex;
      const modes = MODES(hljs);
      const VENDOR_PREFIX = { begin: /-(webkit|moz|ms|o)-(?=[a-z])/ };
      const AT_MODIFIERS = "and or not only";
      const AT_PROPERTY_RE = /@-?\w[\w]*(-\w+)*/;
      const IDENT_RE = "[a-zA-Z-][a-zA-Z0-9_-]*";
      const STRINGS = [
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE
      ];
      return {
        name: "CSS",
        case_insensitive: true,
        illegal: /[=|'\$]/,
        keywords: { keyframePosition: "from to" },
        classNameAliases: {
          // for visual continuity with `tag {}` and because we
          // don't have a great class for this?
          keyframePosition: "selector-tag"
        },
        contains: [
          modes.BLOCK_COMMENT,
          VENDOR_PREFIX,
          // to recognize keyframe 40% etc which are outside the scope of our
          // attribute value mode
          modes.CSS_NUMBER_MODE,
          {
            className: "selector-id",
            begin: /#[A-Za-z0-9_-]+/,
            relevance: 0
          },
          {
            className: "selector-class",
            begin: "\\." + IDENT_RE,
            relevance: 0
          },
          modes.ATTRIBUTE_SELECTOR_MODE,
          {
            className: "selector-pseudo",
            variants: [
              { begin: ":(" + PSEUDO_CLASSES.join("|") + ")" },
              { begin: ":(:)?(" + PSEUDO_ELEMENTS.join("|") + ")" }
            ]
          },
          // we may actually need this (12/2020)
          // { // pseudo-selector params
          //   begin: /\(/,
          //   end: /\)/,
          //   contains: [ hljs.CSS_NUMBER_MODE ]
          // },
          modes.CSS_VARIABLE,
          {
            className: "attribute",
            begin: "\\b(" + ATTRIBUTES.join("|") + ")\\b"
          },
          // attribute values
          {
            begin: /:/,
            end: /[;}{]/,
            contains: [
              modes.BLOCK_COMMENT,
              modes.HEXCOLOR,
              modes.IMPORTANT,
              modes.CSS_NUMBER_MODE,
              ...STRINGS,
              // needed to highlight these as strings and to avoid issues with
              // illegal characters that might be inside urls that would tigger the
              // languages illegal stack
              {
                begin: /(url|data-uri)\(/,
                end: /\)/,
                relevance: 0,
                // from keywords
                keywords: { built_in: "url data-uri" },
                contains: [
                  ...STRINGS,
                  {
                    className: "string",
                    // any character other than `)` as in `url()` will be the start
                    // of a string, which ends with `)` (from the parent mode)
                    begin: /[^)]/,
                    endsWithParent: true,
                    excludeEnd: true
                  }
                ]
              },
              modes.FUNCTION_DISPATCH
            ]
          },
          {
            begin: regex.lookahead(/@/),
            end: "[{;]",
            relevance: 0,
            illegal: /:/,
            // break on Less variables @var: ...
            contains: [
              {
                className: "keyword",
                begin: AT_PROPERTY_RE
              },
              {
                begin: /\s/,
                endsWithParent: true,
                excludeEnd: true,
                relevance: 0,
                keywords: {
                  $pattern: /[a-z-]+/,
                  keyword: AT_MODIFIERS,
                  attribute: MEDIA_FEATURES.join(" ")
                },
                contains: [
                  {
                    begin: /[a-z-]+(?=:)/,
                    className: "attribute"
                  },
                  ...STRINGS,
                  modes.CSS_NUMBER_MODE
                ]
              }
            ]
          },
          {
            className: "selector-tag",
            begin: "\\b(" + TAGS.join("|") + ")\\b"
          }
        ]
      };
    }
    module.exports = css;
  }
});

// node_modules/highlight.js/lib/languages/markdown.js
var require_markdown = __commonJS({
  "node_modules/highlight.js/lib/languages/markdown.js"(exports, module) {
    function markdown(hljs) {
      const regex = hljs.regex;
      const INLINE_HTML = {
        begin: /<\/?[A-Za-z_]/,
        end: ">",
        subLanguage: "xml",
        relevance: 0
      };
      const HORIZONTAL_RULE = {
        begin: "^[-\\*]{3,}",
        end: "$"
      };
      const CODE = {
        className: "code",
        variants: [
          // TODO: fix to allow these to work with sublanguage also
          { begin: "(`{3,})[^`](.|\\n)*?\\1`*[ ]*" },
          { begin: "(~{3,})[^~](.|\\n)*?\\1~*[ ]*" },
          // needed to allow markdown as a sublanguage to work
          {
            begin: "```",
            end: "```+[ ]*$"
          },
          {
            begin: "~~~",
            end: "~~~+[ ]*$"
          },
          { begin: "`.+?`" },
          {
            begin: "(?=^( {4}|\\t))",
            // use contains to gobble up multiple lines to allow the block to be whatever size
            // but only have a single open/close tag vs one per line
            contains: [
              {
                begin: "^( {4}|\\t)",
                end: "(\\n)$"
              }
            ],
            relevance: 0
          }
        ]
      };
      const LIST = {
        className: "bullet",
        begin: "^[ 	]*([*+-]|(\\d+\\.))(?=\\s+)",
        end: "\\s+",
        excludeEnd: true
      };
      const LINK_REFERENCE = {
        begin: /^\[[^\n]+\]:/,
        returnBegin: true,
        contains: [
          {
            className: "symbol",
            begin: /\[/,
            end: /\]/,
            excludeBegin: true,
            excludeEnd: true
          },
          {
            className: "link",
            begin: /:\s*/,
            end: /$/,
            excludeBegin: true
          }
        ]
      };
      const URL_SCHEME = /[A-Za-z][A-Za-z0-9+.-]*/;
      const LINK = {
        variants: [
          // too much like nested array access in so many languages
          // to have any real relevance
          {
            begin: /\[.+?\]\[.*?\]/,
            relevance: 0
          },
          // popular internet URLs
          {
            begin: /\[.+?\]\(((data|javascript|mailto):|(?:http|ftp)s?:\/\/).*?\)/,
            relevance: 2
          },
          {
            begin: regex.concat(/\[.+?\]\(/, URL_SCHEME, /:\/\/.*?\)/),
            relevance: 2
          },
          // relative urls
          {
            begin: /\[.+?\]\([./?&#].*?\)/,
            relevance: 1
          },
          // whatever else, lower relevance (might not be a link at all)
          {
            begin: /\[.*?\]\(.*?\)/,
            relevance: 0
          }
        ],
        returnBegin: true,
        contains: [
          {
            // empty strings for alt or link text
            match: /\[(?=\])/
          },
          {
            className: "string",
            relevance: 0,
            begin: "\\[",
            end: "\\]",
            excludeBegin: true,
            returnEnd: true
          },
          {
            className: "link",
            relevance: 0,
            begin: "\\]\\(",
            end: "\\)",
            excludeBegin: true,
            excludeEnd: true
          },
          {
            className: "symbol",
            relevance: 0,
            begin: "\\]\\[",
            end: "\\]",
            excludeBegin: true,
            excludeEnd: true
          }
        ]
      };
      const BOLD = {
        className: "strong",
        contains: [],
        // defined later
        variants: [
          {
            begin: /_{2}(?!\s)/,
            end: /_{2}/
          },
          {
            begin: /\*{2}(?!\s)/,
            end: /\*{2}/
          }
        ]
      };
      const ITALIC = {
        className: "emphasis",
        contains: [],
        // defined later
        variants: [
          {
            begin: /\*(?![*\s])/,
            end: /\*/
          },
          {
            begin: /_(?![_\s])/,
            end: /_/,
            relevance: 0
          }
        ]
      };
      const BOLD_WITHOUT_ITALIC = hljs.inherit(BOLD, { contains: [] });
      const ITALIC_WITHOUT_BOLD = hljs.inherit(ITALIC, { contains: [] });
      BOLD.contains.push(ITALIC_WITHOUT_BOLD);
      ITALIC.contains.push(BOLD_WITHOUT_ITALIC);
      let CONTAINABLE = [
        INLINE_HTML,
        LINK
      ];
      [
        BOLD,
        ITALIC,
        BOLD_WITHOUT_ITALIC,
        ITALIC_WITHOUT_BOLD
      ].forEach((m6) => {
        m6.contains = m6.contains.concat(CONTAINABLE);
      });
      CONTAINABLE = CONTAINABLE.concat(BOLD, ITALIC);
      const HEADER = {
        className: "section",
        variants: [
          {
            begin: "^#{1,6}",
            end: "$",
            contains: CONTAINABLE
          },
          {
            begin: "(?=^.+?\\n[=-]{2,}$)",
            contains: [
              { begin: "^[=-]*$" },
              {
                begin: "^",
                end: "\\n",
                contains: CONTAINABLE
              }
            ]
          }
        ]
      };
      const BLOCKQUOTE = {
        className: "quote",
        begin: "^>\\s+",
        contains: CONTAINABLE,
        end: "$"
      };
      const ENTITY = {
        //https://spec.commonmark.org/0.31.2/#entity-references
        scope: "literal",
        match: /&([a-zA-Z0-9]+|#[0-9]{1,7}|#[Xx][0-9a-fA-F]{1,6});/
      };
      return {
        name: "Markdown",
        aliases: [
          "md",
          "mkdown",
          "mkd"
        ],
        contains: [
          HEADER,
          INLINE_HTML,
          LIST,
          BOLD,
          ITALIC,
          BLOCKQUOTE,
          CODE,
          HORIZONTAL_RULE,
          LINK,
          LINK_REFERENCE,
          ENTITY
        ]
      };
    }
    module.exports = markdown;
  }
});

// node_modules/highlight.js/lib/languages/diff.js
var require_diff = __commonJS({
  "node_modules/highlight.js/lib/languages/diff.js"(exports, module) {
    function diff(hljs) {
      const regex = hljs.regex;
      return {
        name: "Diff",
        aliases: ["patch"],
        contains: [
          {
            className: "meta",
            relevance: 10,
            match: regex.either(
              /^@@ +-\d+,\d+ +\+\d+,\d+ +@@/,
              /^\*\*\* +\d+,\d+ +\*\*\*\*$/,
              /^--- +\d+,\d+ +----$/
            )
          },
          {
            className: "comment",
            variants: [
              {
                begin: regex.either(
                  /Index: /,
                  /^index/,
                  /={3,}/,
                  /^-{3}/,
                  /^\*{3} /,
                  /^\+{3}/,
                  /^diff --git/
                ),
                end: /$/
              },
              { match: /^\*{15}$/ }
            ]
          },
          {
            className: "addition",
            begin: /^\+/,
            end: /$/
          },
          {
            className: "deletion",
            begin: /^-/,
            end: /$/
          },
          {
            className: "addition",
            begin: /^!/,
            end: /$/
          }
        ]
      };
    }
    module.exports = diff;
  }
});

// node_modules/highlight.js/lib/languages/ruby.js
var require_ruby = __commonJS({
  "node_modules/highlight.js/lib/languages/ruby.js"(exports, module) {
    function ruby(hljs) {
      const regex = hljs.regex;
      const RUBY_METHOD_RE = "([a-zA-Z_]\\w*[!?=]?|[-+~]@|<<|>>|=~|===?|<=>|[<>]=?|\\*\\*|[-/+%^&*~`|]|\\[\\]=?)";
      const CLASS_NAME_RE = regex.either(
        /\b([A-Z]+[a-z0-9]+)+/,
        // ends in caps
        /\b([A-Z]+[a-z0-9]+)+[A-Z]+/
      );
      const CLASS_NAME_WITH_NAMESPACE_RE = regex.concat(CLASS_NAME_RE, /(::\w+)*/);
      const PSEUDO_KWS = [
        "include",
        "extend",
        "prepend",
        "public",
        "private",
        "protected",
        "raise",
        "throw"
      ];
      const RUBY_KEYWORDS = {
        "variable.constant": [
          "__FILE__",
          "__LINE__",
          "__ENCODING__"
        ],
        "variable.language": [
          "self",
          "super"
        ],
        keyword: [
          "alias",
          "and",
          "begin",
          "BEGIN",
          "break",
          "case",
          "class",
          "defined",
          "do",
          "else",
          "elsif",
          "end",
          "END",
          "ensure",
          "for",
          "if",
          "in",
          "module",
          "next",
          "not",
          "or",
          "redo",
          "require",
          "rescue",
          "retry",
          "return",
          "then",
          "undef",
          "unless",
          "until",
          "when",
          "while",
          "yield",
          ...PSEUDO_KWS
        ],
        built_in: [
          "proc",
          "lambda",
          "attr_accessor",
          "attr_reader",
          "attr_writer",
          "define_method",
          "private_constant",
          "module_function"
        ],
        literal: [
          "true",
          "false",
          "nil"
        ]
      };
      const YARDOCTAG = {
        className: "doctag",
        begin: "@[A-Za-z]+"
      };
      const IRB_OBJECT = {
        begin: "#<",
        end: ">"
      };
      const COMMENT_MODES = [
        hljs.COMMENT(
          "#",
          "$",
          { contains: [YARDOCTAG] }
        ),
        hljs.COMMENT(
          "^=begin",
          "^=end",
          {
            contains: [YARDOCTAG],
            relevance: 10
          }
        ),
        hljs.COMMENT("^__END__", hljs.MATCH_NOTHING_RE)
      ];
      const SUBST = {
        className: "subst",
        begin: /#\{/,
        end: /\}/,
        keywords: RUBY_KEYWORDS
      };
      const STRING = {
        className: "string",
        contains: [
          hljs.BACKSLASH_ESCAPE,
          SUBST
        ],
        variants: [
          {
            begin: /'/,
            end: /'/
          },
          {
            begin: /"/,
            end: /"/
          },
          {
            begin: /`/,
            end: /`/
          },
          {
            begin: /%[qQwWx]?\(/,
            end: /\)/
          },
          {
            begin: /%[qQwWx]?\[/,
            end: /\]/
          },
          {
            begin: /%[qQwWx]?\{/,
            end: /\}/
          },
          {
            begin: /%[qQwWx]?</,
            end: />/
          },
          {
            begin: /%[qQwWx]?\//,
            end: /\//
          },
          {
            begin: /%[qQwWx]?%/,
            end: /%/
          },
          {
            begin: /%[qQwWx]?-/,
            end: /-/
          },
          {
            begin: /%[qQwWx]?\|/,
            end: /\|/
          },
          // in the following expressions, \B in the beginning suppresses recognition of ?-sequences
          // where ? is the last character of a preceding identifier, as in: `func?4`
          { begin: /\B\?(\\\d{1,3})/ },
          { begin: /\B\?(\\x[A-Fa-f0-9]{1,2})/ },
          { begin: /\B\?(\\u\{?[A-Fa-f0-9]{1,6}\}?)/ },
          { begin: /\B\?(\\M-\\C-|\\M-\\c|\\c\\M-|\\M-|\\C-\\M-)[\x20-\x7e]/ },
          { begin: /\B\?\\(c|C-)[\x20-\x7e]/ },
          { begin: /\B\?\\?\S/ },
          // heredocs
          {
            // this guard makes sure that we have an entire heredoc and not a false
            // positive (auto-detect, etc.)
            begin: regex.concat(
              /<<[-~]?'?/,
              regex.lookahead(/(\w+)(?=\W)[^\n]*\n(?:[^\n]*\n)*?\s*\1\b/)
            ),
            contains: [
              hljs.END_SAME_AS_BEGIN({
                begin: /(\w+)/,
                end: /(\w+)/,
                contains: [
                  hljs.BACKSLASH_ESCAPE,
                  SUBST
                ]
              })
            ]
          }
        ]
      };
      const decimal = "[1-9](_?[0-9])*|0";
      const digits = "[0-9](_?[0-9])*";
      const NUMBER = {
        className: "number",
        relevance: 0,
        variants: [
          // decimal integer/float, optionally exponential or rational, optionally imaginary
          { begin: `\\b(${decimal})(\\.(${digits}))?([eE][+-]?(${digits})|r)?i?\\b` },
          // explicit decimal/binary/octal/hexadecimal integer,
          // optionally rational and/or imaginary
          { begin: "\\b0[dD][0-9](_?[0-9])*r?i?\\b" },
          { begin: "\\b0[bB][0-1](_?[0-1])*r?i?\\b" },
          { begin: "\\b0[oO][0-7](_?[0-7])*r?i?\\b" },
          { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*r?i?\\b" },
          // 0-prefixed implicit octal integer, optionally rational and/or imaginary
          { begin: "\\b0(_?[0-7])+r?i?\\b" }
        ]
      };
      const PARAMS = {
        variants: [
          {
            match: /\(\)/
          },
          {
            className: "params",
            begin: /\(/,
            end: /(?=\))/,
            excludeBegin: true,
            endsParent: true,
            keywords: RUBY_KEYWORDS
          }
        ]
      };
      const INCLUDE_EXTEND = {
        match: [
          /(include|extend)\s+/,
          CLASS_NAME_WITH_NAMESPACE_RE
        ],
        scope: {
          2: "title.class"
        },
        keywords: RUBY_KEYWORDS
      };
      const CLASS_DEFINITION = {
        variants: [
          {
            match: [
              /class\s+/,
              CLASS_NAME_WITH_NAMESPACE_RE,
              /\s+<\s+/,
              CLASS_NAME_WITH_NAMESPACE_RE
            ]
          },
          {
            match: [
              /\b(class|module)\s+/,
              CLASS_NAME_WITH_NAMESPACE_RE
            ]
          }
        ],
        scope: {
          2: "title.class",
          4: "title.class.inherited"
        },
        keywords: RUBY_KEYWORDS
      };
      const UPPER_CASE_CONSTANT = {
        relevance: 0,
        match: /\b[A-Z][A-Z_0-9]+\b/,
        className: "variable.constant"
      };
      const METHOD_DEFINITION = {
        match: [
          /def/,
          /\s+/,
          RUBY_METHOD_RE
        ],
        scope: {
          1: "keyword",
          3: "title.function"
        },
        contains: [
          PARAMS
        ]
      };
      const OBJECT_CREATION = {
        relevance: 0,
        match: [
          CLASS_NAME_WITH_NAMESPACE_RE,
          /\.new[. (]/
        ],
        scope: {
          1: "title.class"
        }
      };
      const CLASS_REFERENCE = {
        relevance: 0,
        match: CLASS_NAME_RE,
        scope: "title.class"
      };
      const RUBY_DEFAULT_CONTAINS = [
        STRING,
        CLASS_DEFINITION,
        INCLUDE_EXTEND,
        OBJECT_CREATION,
        UPPER_CASE_CONSTANT,
        CLASS_REFERENCE,
        METHOD_DEFINITION,
        {
          // swallow namespace qualifiers before symbols
          begin: hljs.IDENT_RE + "::"
        },
        {
          className: "symbol",
          begin: hljs.UNDERSCORE_IDENT_RE + "(!|\\?)?:",
          relevance: 0
        },
        {
          className: "symbol",
          begin: ":(?!\\s)",
          contains: [
            STRING,
            { begin: RUBY_METHOD_RE }
          ],
          relevance: 0
        },
        NUMBER,
        {
          // negative-look forward attempts to prevent false matches like:
          // @ident@ or $ident$ that might indicate this is not ruby at all
          className: "variable",
          begin: `(\\$\\W)|((\\$|@@?)(\\w+))(?=[^@$?])(?![A-Za-z])(?![@$?'])`
        },
        {
          className: "params",
          begin: /\|(?!=)/,
          end: /\|/,
          excludeBegin: true,
          excludeEnd: true,
          relevance: 0,
          // this could be a lot of things (in other languages) other than params
          keywords: RUBY_KEYWORDS
        },
        {
          // regexp container
          begin: "(" + hljs.RE_STARTERS_RE + "|unless)\\s*",
          keywords: "unless",
          contains: [
            {
              className: "regexp",
              contains: [
                hljs.BACKSLASH_ESCAPE,
                SUBST
              ],
              illegal: /\n/,
              variants: [
                {
                  begin: "/",
                  end: "/[a-z]*"
                },
                {
                  begin: /%r\{/,
                  end: /\}[a-z]*/
                },
                {
                  begin: "%r\\(",
                  end: "\\)[a-z]*"
                },
                {
                  begin: "%r!",
                  end: "![a-z]*"
                },
                {
                  begin: "%r\\[",
                  end: "\\][a-z]*"
                }
              ]
            }
          ].concat(IRB_OBJECT, COMMENT_MODES),
          relevance: 0
        }
      ].concat(IRB_OBJECT, COMMENT_MODES);
      SUBST.contains = RUBY_DEFAULT_CONTAINS;
      PARAMS.contains = RUBY_DEFAULT_CONTAINS;
      const SIMPLE_PROMPT = "[>?]>";
      const DEFAULT_PROMPT = "[\\w#]+\\(\\w+\\):\\d+:\\d+[>*]";
      const RVM_PROMPT = "(\\w+-)?\\d+\\.\\d+\\.\\d+(p\\d+)?[^\\d][^>]+>";
      const IRB_DEFAULT = [
        {
          begin: /^\s*=>/,
          starts: {
            end: "$",
            contains: RUBY_DEFAULT_CONTAINS
          }
        },
        {
          className: "meta.prompt",
          begin: "^(" + SIMPLE_PROMPT + "|" + DEFAULT_PROMPT + "|" + RVM_PROMPT + ")(?=[ ])",
          starts: {
            end: "$",
            keywords: RUBY_KEYWORDS,
            contains: RUBY_DEFAULT_CONTAINS
          }
        }
      ];
      COMMENT_MODES.unshift(IRB_OBJECT);
      return {
        name: "Ruby",
        aliases: [
          "rb",
          "gemspec",
          "podspec",
          "thor",
          "irb"
        ],
        keywords: RUBY_KEYWORDS,
        illegal: /\/\*/,
        contains: [hljs.SHEBANG({ binary: "ruby" })].concat(IRB_DEFAULT).concat(COMMENT_MODES).concat(RUBY_DEFAULT_CONTAINS)
      };
    }
    module.exports = ruby;
  }
});

// node_modules/highlight.js/lib/languages/go.js
var require_go = __commonJS({
  "node_modules/highlight.js/lib/languages/go.js"(exports, module) {
    function go(hljs) {
      const LITERALS = [
        "true",
        "false",
        "iota",
        "nil"
      ];
      const BUILT_INS = [
        "append",
        "cap",
        "close",
        "complex",
        "copy",
        "imag",
        "len",
        "make",
        "new",
        "panic",
        "print",
        "println",
        "real",
        "recover",
        "delete"
      ];
      const TYPES = [
        "bool",
        "byte",
        "complex64",
        "complex128",
        "error",
        "float32",
        "float64",
        "int8",
        "int16",
        "int32",
        "int64",
        "string",
        "uint8",
        "uint16",
        "uint32",
        "uint64",
        "int",
        "uint",
        "uintptr",
        "rune"
      ];
      const KWS = [
        "break",
        "case",
        "chan",
        "const",
        "continue",
        "default",
        "defer",
        "else",
        "fallthrough",
        "for",
        "func",
        "go",
        "goto",
        "if",
        "import",
        "interface",
        "map",
        "package",
        "range",
        "return",
        "select",
        "struct",
        "switch",
        "type",
        "var"
      ];
      const KEYWORDS = {
        keyword: KWS,
        type: TYPES,
        literal: LITERALS,
        built_in: BUILT_INS
      };
      return {
        name: "Go",
        aliases: ["golang"],
        keywords: KEYWORDS,
        illegal: "</",
        contains: [
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          {
            className: "string",
            variants: [
              hljs.QUOTE_STRING_MODE,
              hljs.APOS_STRING_MODE,
              {
                begin: "`",
                end: "`"
              }
            ]
          },
          {
            className: "number",
            variants: [
              {
                match: /-?\b0[xX]\.[a-fA-F0-9](_?[a-fA-F0-9])*[pP][+-]?\d(_?\d)*i?/,
                // hex without a present digit before . (making a digit afterwards required)
                relevance: 0
              },
              {
                match: /-?\b0[xX](_?[a-fA-F0-9])+((\.([a-fA-F0-9](_?[a-fA-F0-9])*)?)?[pP][+-]?\d(_?\d)*)?i?/,
                // hex with a present digit before . (making a digit afterwards optional)
                relevance: 0
              },
              {
                match: /-?\b0[oO](_?[0-7])*i?/,
                // leading 0o octal
                relevance: 0
              },
              {
                match: /-?\.\d(_?\d)*([eE][+-]?\d(_?\d)*)?i?/,
                // decimal without a present digit before . (making a digit afterwards required)
                relevance: 0
              },
              {
                match: /-?\b\d(_?\d)*(\.(\d(_?\d)*)?)?([eE][+-]?\d(_?\d)*)?i?/,
                // decimal with a present digit before . (making a digit afterwards optional)
                relevance: 0
              }
            ]
          },
          {
            begin: /:=/
            // relevance booster
          },
          {
            className: "function",
            beginKeywords: "func",
            end: "\\s*(\\{|$)",
            excludeEnd: true,
            contains: [
              hljs.TITLE_MODE,
              {
                className: "params",
                begin: /\(/,
                end: /\)/,
                endsParent: true,
                keywords: KEYWORDS,
                illegal: /["']/
              }
            ]
          }
        ]
      };
    }
    module.exports = go;
  }
});

// node_modules/highlight.js/lib/languages/graphql.js
var require_graphql = __commonJS({
  "node_modules/highlight.js/lib/languages/graphql.js"(exports, module) {
    function graphql(hljs) {
      const regex = hljs.regex;
      const GQL_NAME = /[_A-Za-z][_0-9A-Za-z]*/;
      return {
        name: "GraphQL",
        aliases: ["gql"],
        case_insensitive: true,
        disableAutodetect: false,
        keywords: {
          keyword: [
            "query",
            "mutation",
            "subscription",
            "type",
            "input",
            "schema",
            "directive",
            "interface",
            "union",
            "scalar",
            "fragment",
            "enum",
            "on"
          ],
          literal: [
            "true",
            "false",
            "null"
          ]
        },
        contains: [
          hljs.HASH_COMMENT_MODE,
          hljs.QUOTE_STRING_MODE,
          hljs.NUMBER_MODE,
          {
            scope: "punctuation",
            match: /[.]{3}/,
            relevance: 0
          },
          {
            scope: "punctuation",
            begin: /[\!\(\)\:\=\[\]\{\|\}]{1}/,
            relevance: 0
          },
          {
            scope: "variable",
            begin: /\$/,
            end: /\W/,
            excludeEnd: true,
            relevance: 0
          },
          {
            scope: "meta",
            match: /@\w+/,
            excludeEnd: true
          },
          {
            scope: "symbol",
            begin: regex.concat(GQL_NAME, regex.lookahead(/\s*:/)),
            relevance: 0
          }
        ],
        illegal: [
          /[;<']/,
          /BEGIN/
        ]
      };
    }
    module.exports = graphql;
  }
});

// node_modules/highlight.js/lib/languages/ini.js
var require_ini = __commonJS({
  "node_modules/highlight.js/lib/languages/ini.js"(exports, module) {
    function ini(hljs) {
      const regex = hljs.regex;
      const NUMBERS = {
        className: "number",
        relevance: 0,
        variants: [
          { begin: /([+-]+)?[\d]+_[\d_]+/ },
          { begin: hljs.NUMBER_RE }
        ]
      };
      const COMMENTS = hljs.COMMENT();
      COMMENTS.variants = [
        {
          begin: /;/,
          end: /$/
        },
        {
          begin: /#/,
          end: /$/
        }
      ];
      const VARIABLES = {
        className: "variable",
        variants: [
          { begin: /\$[\w\d"][\w\d_]*/ },
          { begin: /\$\{(.*?)\}/ }
        ]
      };
      const LITERALS = {
        className: "literal",
        begin: /\bon|off|true|false|yes|no\b/
      };
      const STRINGS = {
        className: "string",
        contains: [hljs.BACKSLASH_ESCAPE],
        variants: [
          {
            begin: "'''",
            end: "'''",
            relevance: 10
          },
          {
            begin: '"""',
            end: '"""',
            relevance: 10
          },
          {
            begin: '"',
            end: '"'
          },
          {
            begin: "'",
            end: "'"
          }
        ]
      };
      const ARRAY = {
        begin: /\[/,
        end: /\]/,
        contains: [
          COMMENTS,
          LITERALS,
          VARIABLES,
          STRINGS,
          NUMBERS,
          "self"
        ],
        relevance: 0
      };
      const BARE_KEY = /[A-Za-z0-9_-]+/;
      const QUOTED_KEY_DOUBLE_QUOTE = /"(\\"|[^"])*"/;
      const QUOTED_KEY_SINGLE_QUOTE = /'[^']*'/;
      const ANY_KEY = regex.either(
        BARE_KEY,
        QUOTED_KEY_DOUBLE_QUOTE,
        QUOTED_KEY_SINGLE_QUOTE
      );
      const DOTTED_KEY = regex.concat(
        ANY_KEY,
        "(\\s*\\.\\s*",
        ANY_KEY,
        ")*",
        regex.lookahead(/\s*=\s*[^#\s]/)
      );
      return {
        name: "TOML, also INI",
        aliases: ["toml"],
        case_insensitive: true,
        illegal: /\S/,
        contains: [
          COMMENTS,
          {
            className: "section",
            begin: /\[+/,
            end: /\]+/
          },
          {
            begin: DOTTED_KEY,
            className: "attr",
            starts: {
              end: /$/,
              contains: [
                COMMENTS,
                ARRAY,
                LITERALS,
                VARIABLES,
                STRINGS,
                NUMBERS
              ]
            }
          }
        ]
      };
    }
    module.exports = ini;
  }
});

// node_modules/highlight.js/lib/languages/java.js
var require_java = __commonJS({
  "node_modules/highlight.js/lib/languages/java.js"(exports, module) {
    var decimalDigits = "[0-9](_*[0-9])*";
    var frac = `\\.(${decimalDigits})`;
    var hexDigits = "[0-9a-fA-F](_*[0-9a-fA-F])*";
    var NUMERIC = {
      className: "number",
      variants: [
        // DecimalFloatingPointLiteral
        // including ExponentPart
        { begin: `(\\b(${decimalDigits})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})[fFdD]?\\b` },
        // excluding ExponentPart
        { begin: `\\b(${decimalDigits})((${frac})[fFdD]?\\b|\\.([fFdD]\\b)?)` },
        { begin: `(${frac})[fFdD]?\\b` },
        { begin: `\\b(${decimalDigits})[fFdD]\\b` },
        // HexadecimalFloatingPointLiteral
        { begin: `\\b0[xX]((${hexDigits})\\.?|(${hexDigits})?\\.(${hexDigits}))[pP][+-]?(${decimalDigits})[fFdD]?\\b` },
        // DecimalIntegerLiteral
        { begin: "\\b(0|[1-9](_*[0-9])*)[lL]?\\b" },
        // HexIntegerLiteral
        { begin: `\\b0[xX](${hexDigits})[lL]?\\b` },
        // OctalIntegerLiteral
        { begin: "\\b0(_*[0-7])*[lL]?\\b" },
        // BinaryIntegerLiteral
        { begin: "\\b0[bB][01](_*[01])*[lL]?\\b" }
      ],
      relevance: 0
    };
    function recurRegex(re, substitution, depth) {
      if (depth === -1) return "";
      return re.replace(substitution, (_6) => {
        return recurRegex(re, substitution, depth - 1);
      });
    }
    function java(hljs) {
      const regex = hljs.regex;
      const JAVA_IDENT_RE = "[\xC0-\u02B8a-zA-Z_$][\xC0-\u02B8a-zA-Z_$0-9]*";
      const GENERIC_IDENT_RE = JAVA_IDENT_RE + recurRegex("(?:<" + JAVA_IDENT_RE + "~~~(?:\\s*,\\s*" + JAVA_IDENT_RE + "~~~)*>)?", /~~~/g, 2);
      const MAIN_KEYWORDS = [
        "synchronized",
        "abstract",
        "private",
        "var",
        "static",
        "if",
        "const ",
        "for",
        "while",
        "strictfp",
        "finally",
        "protected",
        "import",
        "native",
        "final",
        "void",
        "enum",
        "else",
        "break",
        "transient",
        "catch",
        "instanceof",
        "volatile",
        "case",
        "assert",
        "package",
        "default",
        "public",
        "try",
        "switch",
        "continue",
        "throws",
        "protected",
        "public",
        "private",
        "module",
        "requires",
        "exports",
        "do",
        "sealed",
        "yield",
        "permits",
        "goto",
        "when"
      ];
      const BUILT_INS = [
        "super",
        "this"
      ];
      const LITERALS = [
        "false",
        "true",
        "null"
      ];
      const TYPES = [
        "char",
        "boolean",
        "long",
        "float",
        "int",
        "byte",
        "short",
        "double"
      ];
      const KEYWORDS = {
        keyword: MAIN_KEYWORDS,
        literal: LITERALS,
        type: TYPES,
        built_in: BUILT_INS
      };
      const ANNOTATION = {
        className: "meta",
        begin: "@" + JAVA_IDENT_RE,
        contains: [
          {
            begin: /\(/,
            end: /\)/,
            contains: ["self"]
            // allow nested () inside our annotation
          }
        ]
      };
      const PARAMS = {
        className: "params",
        begin: /\(/,
        end: /\)/,
        keywords: KEYWORDS,
        relevance: 0,
        contains: [hljs.C_BLOCK_COMMENT_MODE],
        endsParent: true
      };
      return {
        name: "Java",
        aliases: ["jsp"],
        keywords: KEYWORDS,
        illegal: /<\/|#/,
        contains: [
          hljs.COMMENT(
            "/\\*\\*",
            "\\*/",
            {
              relevance: 0,
              contains: [
                {
                  // eat up @'s in emails to prevent them to be recognized as doctags
                  begin: /\w+@/,
                  relevance: 0
                },
                {
                  className: "doctag",
                  begin: "@[A-Za-z]+"
                }
              ]
            }
          ),
          // relevance boost
          {
            begin: /import java\.[a-z]+\./,
            keywords: "import",
            relevance: 2
          },
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          {
            begin: /"""/,
            end: /"""/,
            className: "string",
            contains: [hljs.BACKSLASH_ESCAPE]
          },
          hljs.APOS_STRING_MODE,
          hljs.QUOTE_STRING_MODE,
          {
            match: [
              /\b(?:class|interface|enum|extends|implements|new)/,
              /\s+/,
              JAVA_IDENT_RE
            ],
            className: {
              1: "keyword",
              3: "title.class"
            }
          },
          {
            // Exceptions for hyphenated keywords
            match: /non-sealed/,
            scope: "keyword"
          },
          {
            begin: [
              regex.concat(/(?!else)/, JAVA_IDENT_RE),
              /\s+/,
              JAVA_IDENT_RE,
              /\s+/,
              /=(?!=)/
            ],
            className: {
              1: "type",
              3: "variable",
              5: "operator"
            }
          },
          {
            begin: [
              /record/,
              /\s+/,
              JAVA_IDENT_RE
            ],
            className: {
              1: "keyword",
              3: "title.class"
            },
            contains: [
              PARAMS,
              hljs.C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE
            ]
          },
          {
            // Expression keywords prevent 'keyword Name(...)' from being
            // recognized as a function definition
            beginKeywords: "new throw return else",
            relevance: 0
          },
          {
            begin: [
              "(?:" + GENERIC_IDENT_RE + "\\s+)",
              hljs.UNDERSCORE_IDENT_RE,
              /\s*(?=\()/
            ],
            className: { 2: "title.function" },
            keywords: KEYWORDS,
            contains: [
              {
                className: "params",
                begin: /\(/,
                end: /\)/,
                keywords: KEYWORDS,
                relevance: 0,
                contains: [
                  ANNOTATION,
                  hljs.APOS_STRING_MODE,
                  hljs.QUOTE_STRING_MODE,
                  NUMERIC,
                  hljs.C_BLOCK_COMMENT_MODE
                ]
              },
              hljs.C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE
            ]
          },
          NUMERIC,
          ANNOTATION
        ]
      };
    }
    module.exports = java;
  }
});

// node_modules/highlight.js/lib/languages/javascript.js
var require_javascript = __commonJS({
  "node_modules/highlight.js/lib/languages/javascript.js"(exports, module) {
    var IDENT_RE = "[A-Za-z$_][0-9A-Za-z$_]*";
    var KEYWORDS = [
      "as",
      // for exports
      "in",
      "of",
      "if",
      "for",
      "while",
      "finally",
      "var",
      "new",
      "function",
      "do",
      "return",
      "void",
      "else",
      "break",
      "catch",
      "instanceof",
      "with",
      "throw",
      "case",
      "default",
      "try",
      "switch",
      "continue",
      "typeof",
      "delete",
      "let",
      "yield",
      "const",
      "class",
      // JS handles these with a special rule
      // "get",
      // "set",
      "debugger",
      "async",
      "await",
      "static",
      "import",
      "from",
      "export",
      "extends",
      // It's reached stage 3, which is "recommended for implementation":
      "using"
    ];
    var LITERALS = [
      "true",
      "false",
      "null",
      "undefined",
      "NaN",
      "Infinity"
    ];
    var TYPES = [
      // Fundamental objects
      "Object",
      "Function",
      "Boolean",
      "Symbol",
      // numbers and dates
      "Math",
      "Date",
      "Number",
      "BigInt",
      // text
      "String",
      "RegExp",
      // Indexed collections
      "Array",
      "Float32Array",
      "Float64Array",
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Int32Array",
      "Uint16Array",
      "Uint32Array",
      "BigInt64Array",
      "BigUint64Array",
      // Keyed collections
      "Set",
      "Map",
      "WeakSet",
      "WeakMap",
      // Structured data
      "ArrayBuffer",
      "SharedArrayBuffer",
      "Atomics",
      "DataView",
      "JSON",
      // Control abstraction objects
      "Promise",
      "Generator",
      "GeneratorFunction",
      "AsyncFunction",
      // Reflection
      "Reflect",
      "Proxy",
      // Internationalization
      "Intl",
      // WebAssembly
      "WebAssembly"
    ];
    var ERROR_TYPES = [
      "Error",
      "EvalError",
      "InternalError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "TypeError",
      "URIError"
    ];
    var BUILT_IN_GLOBALS = [
      "setInterval",
      "setTimeout",
      "clearInterval",
      "clearTimeout",
      "require",
      "exports",
      "eval",
      "isFinite",
      "isNaN",
      "parseFloat",
      "parseInt",
      "decodeURI",
      "decodeURIComponent",
      "encodeURI",
      "encodeURIComponent",
      "escape",
      "unescape"
    ];
    var BUILT_IN_VARIABLES = [
      "arguments",
      "this",
      "super",
      "console",
      "window",
      "document",
      "localStorage",
      "sessionStorage",
      "module",
      "global"
      // Node.js
    ];
    var BUILT_INS = [].concat(
      BUILT_IN_GLOBALS,
      TYPES,
      ERROR_TYPES
    );
    function javascript(hljs) {
      const regex = hljs.regex;
      const hasClosingTag = (match2, { after }) => {
        const tag = "</" + match2[0].slice(1);
        const pos = match2.input.indexOf(tag, after);
        return pos !== -1;
      };
      const IDENT_RE$1 = IDENT_RE;
      const FRAGMENT = {
        begin: "<>",
        end: "</>"
      };
      const XML_SELF_CLOSING = /<[A-Za-z0-9\\._:-]+\s*\/>/;
      const XML_TAG = {
        begin: /<[A-Za-z0-9\\._:-]+/,
        end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
        /**
         * @param {RegExpMatchArray} match
         * @param {CallbackResponse} response
         */
        isTrulyOpeningTag: (match2, response) => {
          const afterMatchIndex = match2[0].length + match2.index;
          const nextChar = match2.input[afterMatchIndex];
          if (
            // HTML should not include another raw `<` inside a tag
            // nested type?
            // `<Array<Array<number>>`, etc.
            nextChar === "<" || // the , gives away that this is not HTML
            // `<T, A extends keyof T, V>`
            nextChar === ","
          ) {
            response.ignoreMatch();
            return;
          }
          if (nextChar === ">") {
            if (!hasClosingTag(match2, { after: afterMatchIndex })) {
              response.ignoreMatch();
            }
          }
          let m6;
          const afterMatch = match2.input.substring(afterMatchIndex);
          if (m6 = afterMatch.match(/^\s*=/)) {
            response.ignoreMatch();
            return;
          }
          if (m6 = afterMatch.match(/^\s+extends\s+/)) {
            if (m6.index === 0) {
              response.ignoreMatch();
              return;
            }
          }
        }
      };
      const KEYWORDS$1 = {
        $pattern: IDENT_RE,
        keyword: KEYWORDS,
        literal: LITERALS,
        built_in: BUILT_INS,
        "variable.language": BUILT_IN_VARIABLES
      };
      const decimalDigits = "[0-9](_?[0-9])*";
      const frac = `\\.(${decimalDigits})`;
      const decimalInteger = `0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*`;
      const NUMBER = {
        className: "number",
        variants: [
          // DecimalLiteral
          { begin: `(\\b(${decimalInteger})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})\\b` },
          { begin: `\\b(${decimalInteger})\\b((${frac})\\b|\\.)?|(${frac})\\b` },
          // DecimalBigIntegerLiteral
          { begin: `\\b(0|[1-9](_?[0-9])*)n\\b` },
          // NonDecimalIntegerLiteral
          { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
          { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
          { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
          // LegacyOctalIntegerLiteral (does not include underscore separators)
          // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
          { begin: "\\b0[0-7]+n?\\b" }
        ],
        relevance: 0
      };
      const SUBST = {
        className: "subst",
        begin: "\\$\\{",
        end: "\\}",
        keywords: KEYWORDS$1,
        contains: []
        // defined later
      };
      const HTML_TEMPLATE = {
        begin: ".?html`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "xml"
        }
      };
      const CSS_TEMPLATE = {
        begin: ".?css`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "css"
        }
      };
      const GRAPHQL_TEMPLATE = {
        begin: ".?gql`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "graphql"
        }
      };
      const TEMPLATE_STRING = {
        className: "string",
        begin: "`",
        end: "`",
        contains: [
          hljs.BACKSLASH_ESCAPE,
          SUBST
        ]
      };
      const JSDOC_COMMENT = hljs.COMMENT(
        /\/\*\*(?!\/)/,
        "\\*/",
        {
          relevance: 0,
          contains: [
            {
              begin: "(?=@[A-Za-z]+)",
              relevance: 0,
              contains: [
                {
                  className: "doctag",
                  begin: "@[A-Za-z]+"
                },
                {
                  className: "type",
                  begin: "\\{",
                  end: "\\}",
                  excludeEnd: true,
                  excludeBegin: true,
                  relevance: 0
                },
                {
                  className: "variable",
                  begin: IDENT_RE$1 + "(?=\\s*(-)|$)",
                  endsParent: true,
                  relevance: 0
                },
                // eat spaces (not newlines) so we can find
                // types or variables
                {
                  begin: /(?=[^\n])\s/,
                  relevance: 0
                }
              ]
            }
          ]
        }
      );
      const COMMENT = {
        className: "comment",
        variants: [
          JSDOC_COMMENT,
          hljs.C_BLOCK_COMMENT_MODE,
          hljs.C_LINE_COMMENT_MODE
        ]
      };
      const SUBST_INTERNALS = [
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE,
        HTML_TEMPLATE,
        CSS_TEMPLATE,
        GRAPHQL_TEMPLATE,
        TEMPLATE_STRING,
        // Skip numbers when they are part of a variable name
        { match: /\$\d+/ },
        NUMBER
        // This is intentional:
        // See https://github.com/highlightjs/highlight.js/issues/3288
        // hljs.REGEXP_MODE
      ];
      SUBST.contains = SUBST_INTERNALS.concat({
        // we need to pair up {} inside our subst to prevent
        // it from ending too early by matching another }
        begin: /\{/,
        end: /\}/,
        keywords: KEYWORDS$1,
        contains: [
          "self"
        ].concat(SUBST_INTERNALS)
      });
      const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
      const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
        // eat recursive parens in sub expressions
        {
          begin: /(\s*)\(/,
          end: /\)/,
          keywords: KEYWORDS$1,
          contains: ["self"].concat(SUBST_AND_COMMENTS)
        }
      ]);
      const PARAMS = {
        className: "params",
        // convert this to negative lookbehind in v12
        begin: /(\s*)\(/,
        // to match the parms with
        end: /\)/,
        excludeBegin: true,
        excludeEnd: true,
        keywords: KEYWORDS$1,
        contains: PARAMS_CONTAINS
      };
      const CLASS_OR_EXTENDS = {
        variants: [
          // class Car extends vehicle
          {
            match: [
              /class/,
              /\s+/,
              IDENT_RE$1,
              /\s+/,
              /extends/,
              /\s+/,
              regex.concat(IDENT_RE$1, "(", regex.concat(/\./, IDENT_RE$1), ")*")
            ],
            scope: {
              1: "keyword",
              3: "title.class",
              5: "keyword",
              7: "title.class.inherited"
            }
          },
          // class Car
          {
            match: [
              /class/,
              /\s+/,
              IDENT_RE$1
            ],
            scope: {
              1: "keyword",
              3: "title.class"
            }
          }
        ]
      };
      const CLASS_REFERENCE = {
        relevance: 0,
        match: regex.either(
          // Hard coded exceptions
          /\bJSON/,
          // Float32Array, OutT
          /\b[A-Z][a-z]+([A-Z][a-z]*|\d)*/,
          // CSSFactory, CSSFactoryT
          /\b[A-Z]{2,}([A-Z][a-z]+|\d)+([A-Z][a-z]*)*/,
          // FPs, FPsT
          /\b[A-Z]{2,}[a-z]+([A-Z][a-z]+|\d)*([A-Z][a-z]*)*/
          // P
          // single letters are not highlighted
          // BLAH
          // this will be flagged as a UPPER_CASE_CONSTANT instead
        ),
        className: "title.class",
        keywords: {
          _: [
            // se we still get relevance credit for JS library classes
            ...TYPES,
            ...ERROR_TYPES
          ]
        }
      };
      const USE_STRICT = {
        label: "use_strict",
        className: "meta",
        relevance: 10,
        begin: /^\s*['"]use (strict|asm)['"]/
      };
      const FUNCTION_DEFINITION = {
        variants: [
          {
            match: [
              /function/,
              /\s+/,
              IDENT_RE$1,
              /(?=\s*\()/
            ]
          },
          // anonymous function
          {
            match: [
              /function/,
              /\s*(?=\()/
            ]
          }
        ],
        className: {
          1: "keyword",
          3: "title.function"
        },
        label: "func.def",
        contains: [PARAMS],
        illegal: /%/
      };
      const UPPER_CASE_CONSTANT = {
        relevance: 0,
        match: /\b[A-Z][A-Z_0-9]+\b/,
        className: "variable.constant"
      };
      function noneOf(list) {
        return regex.concat("(?!", list.join("|"), ")");
      }
      const FUNCTION_CALL = {
        match: regex.concat(
          /\b/,
          noneOf([
            ...BUILT_IN_GLOBALS,
            "super",
            "import"
          ].map((x6) => `${x6}\\s*\\(`)),
          IDENT_RE$1,
          regex.lookahead(/\s*\(/)
        ),
        className: "title.function",
        relevance: 0
      };
      const PROPERTY_ACCESS = {
        begin: regex.concat(/\./, regex.lookahead(
          regex.concat(IDENT_RE$1, /(?![0-9A-Za-z$_(])/)
        )),
        end: IDENT_RE$1,
        excludeBegin: true,
        keywords: "prototype",
        className: "property",
        relevance: 0
      };
      const GETTER_OR_SETTER = {
        match: [
          /get|set/,
          /\s+/,
          IDENT_RE$1,
          /(?=\()/
        ],
        className: {
          1: "keyword",
          3: "title.function"
        },
        contains: [
          {
            // eat to avoid empty params
            begin: /\(\)/
          },
          PARAMS
        ]
      };
      const FUNC_LEAD_IN_RE = "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + hljs.UNDERSCORE_IDENT_RE + ")\\s*=>";
      const FUNCTION_VARIABLE = {
        match: [
          /const|var|let/,
          /\s+/,
          IDENT_RE$1,
          /\s*/,
          /=\s*/,
          /(async\s*)?/,
          // async is optional
          regex.lookahead(FUNC_LEAD_IN_RE)
        ],
        keywords: "async",
        className: {
          1: "keyword",
          3: "title.function"
        },
        contains: [
          PARAMS
        ]
      };
      return {
        name: "JavaScript",
        aliases: ["js", "jsx", "mjs", "cjs"],
        keywords: KEYWORDS$1,
        // this will be extended by TypeScript
        exports: { PARAMS_CONTAINS, CLASS_REFERENCE },
        illegal: /#(?![$_A-z])/,
        contains: [
          hljs.SHEBANG({
            label: "shebang",
            binary: "node",
            relevance: 5
          }),
          USE_STRICT,
          hljs.APOS_STRING_MODE,
          hljs.QUOTE_STRING_MODE,
          HTML_TEMPLATE,
          CSS_TEMPLATE,
          GRAPHQL_TEMPLATE,
          TEMPLATE_STRING,
          COMMENT,
          // Skip numbers when they are part of a variable name
          { match: /\$\d+/ },
          NUMBER,
          CLASS_REFERENCE,
          {
            scope: "attr",
            match: IDENT_RE$1 + regex.lookahead(":"),
            relevance: 0
          },
          FUNCTION_VARIABLE,
          {
            // "value" container
            begin: "(" + hljs.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
            keywords: "return throw case",
            relevance: 0,
            contains: [
              COMMENT,
              hljs.REGEXP_MODE,
              {
                className: "function",
                // we have to count the parens to make sure we actually have the
                // correct bounding ( ) before the =>.  There could be any number of
                // sub-expressions inside also surrounded by parens.
                begin: FUNC_LEAD_IN_RE,
                returnBegin: true,
                end: "\\s*=>",
                contains: [
                  {
                    className: "params",
                    variants: [
                      {
                        begin: hljs.UNDERSCORE_IDENT_RE,
                        relevance: 0
                      },
                      {
                        className: null,
                        begin: /\(\s*\)/,
                        skip: true
                      },
                      {
                        begin: /(\s*)\(/,
                        end: /\)/,
                        excludeBegin: true,
                        excludeEnd: true,
                        keywords: KEYWORDS$1,
                        contains: PARAMS_CONTAINS
                      }
                    ]
                  }
                ]
              },
              {
                // could be a comma delimited list of params to a function call
                begin: /,/,
                relevance: 0
              },
              {
                match: /\s+/,
                relevance: 0
              },
              {
                // JSX
                variants: [
                  { begin: FRAGMENT.begin, end: FRAGMENT.end },
                  { match: XML_SELF_CLOSING },
                  {
                    begin: XML_TAG.begin,
                    // we carefully check the opening tag to see if it truly
                    // is a tag and not a false positive
                    "on:begin": XML_TAG.isTrulyOpeningTag,
                    end: XML_TAG.end
                  }
                ],
                subLanguage: "xml",
                contains: [
                  {
                    begin: XML_TAG.begin,
                    end: XML_TAG.end,
                    skip: true,
                    contains: ["self"]
                  }
                ]
              }
            ]
          },
          FUNCTION_DEFINITION,
          {
            // prevent this from getting swallowed up by function
            // since they appear "function like"
            beginKeywords: "while if switch catch for"
          },
          {
            // we have to count the parens to make sure we actually have the correct
            // bounding ( ).  There could be any number of sub-expressions inside
            // also surrounded by parens.
            begin: "\\b(?!function)" + hljs.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
            // end parens
            returnBegin: true,
            label: "func.def",
            contains: [
              PARAMS,
              hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1, className: "title.function" })
            ]
          },
          // catch ... so it won't trigger the property rule below
          {
            match: /\.\.\./,
            relevance: 0
          },
          PROPERTY_ACCESS,
          // hack: prevents detection of keywords in some circumstances
          // .keyword()
          // $keyword = x
          {
            match: "\\$" + IDENT_RE$1,
            relevance: 0
          },
          {
            match: [/\bconstructor(?=\s*\()/],
            className: { 1: "title.function" },
            contains: [PARAMS]
          },
          FUNCTION_CALL,
          UPPER_CASE_CONSTANT,
          CLASS_OR_EXTENDS,
          GETTER_OR_SETTER,
          {
            match: /\$[(.]/
            // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
          }
        ]
      };
    }
    module.exports = javascript;
  }
});

// node_modules/highlight.js/lib/languages/json.js
var require_json = __commonJS({
  "node_modules/highlight.js/lib/languages/json.js"(exports, module) {
    function json(hljs) {
      const ATTRIBUTE = {
        className: "attr",
        begin: /"(\\.|[^\\"\r\n])*"(?=\s*:)/,
        relevance: 1.01
      };
      const PUNCTUATION = {
        match: /[{}[\],:]/,
        className: "punctuation",
        relevance: 0
      };
      const LITERALS = [
        "true",
        "false",
        "null"
      ];
      const LITERALS_MODE = {
        scope: "literal",
        beginKeywords: LITERALS.join(" ")
      };
      return {
        name: "JSON",
        aliases: ["jsonc"],
        keywords: {
          literal: LITERALS
        },
        contains: [
          ATTRIBUTE,
          PUNCTUATION,
          hljs.QUOTE_STRING_MODE,
          LITERALS_MODE,
          hljs.C_NUMBER_MODE,
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ],
        illegal: "\\S"
      };
    }
    module.exports = json;
  }
});

// node_modules/highlight.js/lib/languages/kotlin.js
var require_kotlin = __commonJS({
  "node_modules/highlight.js/lib/languages/kotlin.js"(exports, module) {
    var decimalDigits = "[0-9](_*[0-9])*";
    var frac = `\\.(${decimalDigits})`;
    var hexDigits = "[0-9a-fA-F](_*[0-9a-fA-F])*";
    var NUMERIC = {
      className: "number",
      variants: [
        // DecimalFloatingPointLiteral
        // including ExponentPart
        { begin: `(\\b(${decimalDigits})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})[fFdD]?\\b` },
        // excluding ExponentPart
        { begin: `\\b(${decimalDigits})((${frac})[fFdD]?\\b|\\.([fFdD]\\b)?)` },
        { begin: `(${frac})[fFdD]?\\b` },
        { begin: `\\b(${decimalDigits})[fFdD]\\b` },
        // HexadecimalFloatingPointLiteral
        { begin: `\\b0[xX]((${hexDigits})\\.?|(${hexDigits})?\\.(${hexDigits}))[pP][+-]?(${decimalDigits})[fFdD]?\\b` },
        // DecimalIntegerLiteral
        { begin: "\\b(0|[1-9](_*[0-9])*)[lL]?\\b" },
        // HexIntegerLiteral
        { begin: `\\b0[xX](${hexDigits})[lL]?\\b` },
        // OctalIntegerLiteral
        { begin: "\\b0(_*[0-7])*[lL]?\\b" },
        // BinaryIntegerLiteral
        { begin: "\\b0[bB][01](_*[01])*[lL]?\\b" }
      ],
      relevance: 0
    };
    function kotlin(hljs) {
      const KEYWORDS = {
        keyword: "abstract as val var vararg get set class object open private protected public noinline crossinline dynamic final enum if else do while for when throw try catch finally import package is in fun override companion reified inline lateinit init interface annotation data sealed internal infix operator out by constructor super tailrec where const inner suspend typealias external expect actual",
        built_in: "Byte Short Char Int Long Boolean Float Double Void Unit Nothing",
        literal: "true false null"
      };
      const KEYWORDS_WITH_LABEL = {
        className: "keyword",
        begin: /\b(break|continue|return|this)\b/,
        starts: { contains: [
          {
            className: "symbol",
            begin: /@\w+/
          }
        ] }
      };
      const LABEL = {
        className: "symbol",
        begin: hljs.UNDERSCORE_IDENT_RE + "@"
      };
      const SUBST = {
        className: "subst",
        begin: /\$\{/,
        end: /\}/,
        contains: [hljs.C_NUMBER_MODE]
      };
      const VARIABLE = {
        className: "variable",
        begin: "\\$" + hljs.UNDERSCORE_IDENT_RE
      };
      const STRING = {
        className: "string",
        variants: [
          {
            begin: '"""',
            end: '"""(?=[^"])',
            contains: [
              VARIABLE,
              SUBST
            ]
          },
          // Can't use built-in modes easily, as we want to use STRING in the meta
          // context as 'meta-string' and there's no syntax to remove explicitly set
          // classNames in built-in modes.
          {
            begin: "'",
            end: "'",
            illegal: /\n/,
            contains: [hljs.BACKSLASH_ESCAPE]
          },
          {
            begin: '"',
            end: '"',
            illegal: /\n/,
            contains: [
              hljs.BACKSLASH_ESCAPE,
              VARIABLE,
              SUBST
            ]
          }
        ]
      };
      SUBST.contains.push(STRING);
      const ANNOTATION_USE_SITE = {
        className: "meta",
        begin: "@(?:file|property|field|get|set|receiver|param|setparam|delegate)\\s*:(?:\\s*" + hljs.UNDERSCORE_IDENT_RE + ")?"
      };
      const ANNOTATION = {
        className: "meta",
        begin: "@" + hljs.UNDERSCORE_IDENT_RE,
        contains: [
          {
            begin: /\(/,
            end: /\)/,
            contains: [
              hljs.inherit(STRING, { className: "string" }),
              "self"
            ]
          }
        ]
      };
      const KOTLIN_NUMBER_MODE = NUMERIC;
      const KOTLIN_NESTED_COMMENT = hljs.COMMENT(
        "/\\*",
        "\\*/",
        { contains: [hljs.C_BLOCK_COMMENT_MODE] }
      );
      const KOTLIN_PAREN_TYPE = { variants: [
        {
          className: "type",
          begin: hljs.UNDERSCORE_IDENT_RE
        },
        {
          begin: /\(/,
          end: /\)/,
          contains: []
          // defined later
        }
      ] };
      const KOTLIN_PAREN_TYPE2 = KOTLIN_PAREN_TYPE;
      KOTLIN_PAREN_TYPE2.variants[1].contains = [KOTLIN_PAREN_TYPE];
      KOTLIN_PAREN_TYPE.variants[1].contains = [KOTLIN_PAREN_TYPE2];
      return {
        name: "Kotlin",
        aliases: [
          "kt",
          "kts"
        ],
        keywords: KEYWORDS,
        contains: [
          hljs.COMMENT(
            "/\\*\\*",
            "\\*/",
            {
              relevance: 0,
              contains: [
                {
                  className: "doctag",
                  begin: "@[A-Za-z]+"
                }
              ]
            }
          ),
          hljs.C_LINE_COMMENT_MODE,
          KOTLIN_NESTED_COMMENT,
          KEYWORDS_WITH_LABEL,
          LABEL,
          ANNOTATION_USE_SITE,
          ANNOTATION,
          {
            className: "function",
            beginKeywords: "fun",
            end: "[(]|$",
            returnBegin: true,
            excludeEnd: true,
            keywords: KEYWORDS,
            relevance: 5,
            contains: [
              {
                begin: hljs.UNDERSCORE_IDENT_RE + "\\s*\\(",
                returnBegin: true,
                relevance: 0,
                contains: [hljs.UNDERSCORE_TITLE_MODE]
              },
              {
                className: "type",
                begin: /</,
                end: />/,
                keywords: "reified",
                relevance: 0
              },
              {
                className: "params",
                begin: /\(/,
                end: /\)/,
                endsParent: true,
                keywords: KEYWORDS,
                relevance: 0,
                contains: [
                  {
                    begin: /:/,
                    end: /[=,\/]/,
                    endsWithParent: true,
                    contains: [
                      KOTLIN_PAREN_TYPE,
                      hljs.C_LINE_COMMENT_MODE,
                      KOTLIN_NESTED_COMMENT
                    ],
                    relevance: 0
                  },
                  hljs.C_LINE_COMMENT_MODE,
                  KOTLIN_NESTED_COMMENT,
                  ANNOTATION_USE_SITE,
                  ANNOTATION,
                  STRING,
                  hljs.C_NUMBER_MODE
                ]
              },
              KOTLIN_NESTED_COMMENT
            ]
          },
          {
            begin: [
              /class|interface|trait/,
              /\s+/,
              hljs.UNDERSCORE_IDENT_RE
            ],
            beginScope: {
              3: "title.class"
            },
            keywords: "class interface trait",
            end: /[:\{(]|$/,
            excludeEnd: true,
            illegal: "extends implements",
            contains: [
              { beginKeywords: "public protected internal private constructor" },
              hljs.UNDERSCORE_TITLE_MODE,
              {
                className: "type",
                begin: /</,
                end: />/,
                excludeBegin: true,
                excludeEnd: true,
                relevance: 0
              },
              {
                className: "type",
                begin: /[,:]\s*/,
                end: /[<\(,){\s]|$/,
                excludeBegin: true,
                returnEnd: true
              },
              ANNOTATION_USE_SITE,
              ANNOTATION
            ]
          },
          STRING,
          {
            className: "meta",
            begin: "^#!/usr/bin/env",
            end: "$",
            illegal: "\n"
          },
          KOTLIN_NUMBER_MODE
        ]
      };
    }
    module.exports = kotlin;
  }
});

// node_modules/highlight.js/lib/languages/less.js
var require_less = __commonJS({
  "node_modules/highlight.js/lib/languages/less.js"(exports, module) {
    var MODES = (hljs) => {
      return {
        IMPORTANT: {
          scope: "meta",
          begin: "!important"
        },
        BLOCK_COMMENT: hljs.C_BLOCK_COMMENT_MODE,
        HEXCOLOR: {
          scope: "number",
          begin: /#(([0-9a-fA-F]{3,4})|(([0-9a-fA-F]{2}){3,4}))\b/
        },
        FUNCTION_DISPATCH: {
          className: "built_in",
          begin: /[\w-]+(?=\()/
        },
        ATTRIBUTE_SELECTOR_MODE: {
          scope: "selector-attr",
          begin: /\[/,
          end: /\]/,
          illegal: "$",
          contains: [
            hljs.APOS_STRING_MODE,
            hljs.QUOTE_STRING_MODE
          ]
        },
        CSS_NUMBER_MODE: {
          scope: "number",
          begin: hljs.NUMBER_RE + "(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
          relevance: 0
        },
        CSS_VARIABLE: {
          className: "attr",
          begin: /--[A-Za-z_][A-Za-z0-9_-]*/
        }
      };
    };
    var HTML_TAGS = [
      "a",
      "abbr",
      "address",
      "article",
      "aside",
      "audio",
      "b",
      "blockquote",
      "body",
      "button",
      "canvas",
      "caption",
      "cite",
      "code",
      "dd",
      "del",
      "details",
      "dfn",
      "div",
      "dl",
      "dt",
      "em",
      "fieldset",
      "figcaption",
      "figure",
      "footer",
      "form",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hgroup",
      "html",
      "i",
      "iframe",
      "img",
      "input",
      "ins",
      "kbd",
      "label",
      "legend",
      "li",
      "main",
      "mark",
      "menu",
      "nav",
      "object",
      "ol",
      "optgroup",
      "option",
      "p",
      "picture",
      "q",
      "quote",
      "samp",
      "section",
      "select",
      "source",
      "span",
      "strong",
      "summary",
      "sup",
      "table",
      "tbody",
      "td",
      "textarea",
      "tfoot",
      "th",
      "thead",
      "time",
      "tr",
      "ul",
      "var",
      "video"
    ];
    var SVG_TAGS = [
      "defs",
      "g",
      "marker",
      "mask",
      "pattern",
      "svg",
      "switch",
      "symbol",
      "feBlend",
      "feColorMatrix",
      "feComponentTransfer",
      "feComposite",
      "feConvolveMatrix",
      "feDiffuseLighting",
      "feDisplacementMap",
      "feFlood",
      "feGaussianBlur",
      "feImage",
      "feMerge",
      "feMorphology",
      "feOffset",
      "feSpecularLighting",
      "feTile",
      "feTurbulence",
      "linearGradient",
      "radialGradient",
      "stop",
      "circle",
      "ellipse",
      "image",
      "line",
      "path",
      "polygon",
      "polyline",
      "rect",
      "text",
      "use",
      "textPath",
      "tspan",
      "foreignObject",
      "clipPath"
    ];
    var TAGS = [
      ...HTML_TAGS,
      ...SVG_TAGS
    ];
    var MEDIA_FEATURES = [
      "any-hover",
      "any-pointer",
      "aspect-ratio",
      "color",
      "color-gamut",
      "color-index",
      "device-aspect-ratio",
      "device-height",
      "device-width",
      "display-mode",
      "forced-colors",
      "grid",
      "height",
      "hover",
      "inverted-colors",
      "monochrome",
      "orientation",
      "overflow-block",
      "overflow-inline",
      "pointer",
      "prefers-color-scheme",
      "prefers-contrast",
      "prefers-reduced-motion",
      "prefers-reduced-transparency",
      "resolution",
      "scan",
      "scripting",
      "update",
      "width",
      // TODO: find a better solution?
      "min-width",
      "max-width",
      "min-height",
      "max-height"
    ].sort().reverse();
    var PSEUDO_CLASSES = [
      "active",
      "any-link",
      "blank",
      "checked",
      "current",
      "default",
      "defined",
      "dir",
      // dir()
      "disabled",
      "drop",
      "empty",
      "enabled",
      "first",
      "first-child",
      "first-of-type",
      "fullscreen",
      "future",
      "focus",
      "focus-visible",
      "focus-within",
      "has",
      // has()
      "host",
      // host or host()
      "host-context",
      // host-context()
      "hover",
      "indeterminate",
      "in-range",
      "invalid",
      "is",
      // is()
      "lang",
      // lang()
      "last-child",
      "last-of-type",
      "left",
      "link",
      "local-link",
      "not",
      // not()
      "nth-child",
      // nth-child()
      "nth-col",
      // nth-col()
      "nth-last-child",
      // nth-last-child()
      "nth-last-col",
      // nth-last-col()
      "nth-last-of-type",
      //nth-last-of-type()
      "nth-of-type",
      //nth-of-type()
      "only-child",
      "only-of-type",
      "optional",
      "out-of-range",
      "past",
      "placeholder-shown",
      "read-only",
      "read-write",
      "required",
      "right",
      "root",
      "scope",
      "target",
      "target-within",
      "user-invalid",
      "valid",
      "visited",
      "where"
      // where()
    ].sort().reverse();
    var PSEUDO_ELEMENTS = [
      "after",
      "backdrop",
      "before",
      "cue",
      "cue-region",
      "first-letter",
      "first-line",
      "grammar-error",
      "marker",
      "part",
      "placeholder",
      "selection",
      "slotted",
      "spelling-error"
    ].sort().reverse();
    var ATTRIBUTES = [
      "accent-color",
      "align-content",
      "align-items",
      "align-self",
      "alignment-baseline",
      "all",
      "anchor-name",
      "animation",
      "animation-composition",
      "animation-delay",
      "animation-direction",
      "animation-duration",
      "animation-fill-mode",
      "animation-iteration-count",
      "animation-name",
      "animation-play-state",
      "animation-range",
      "animation-range-end",
      "animation-range-start",
      "animation-timeline",
      "animation-timing-function",
      "appearance",
      "aspect-ratio",
      "backdrop-filter",
      "backface-visibility",
      "background",
      "background-attachment",
      "background-blend-mode",
      "background-clip",
      "background-color",
      "background-image",
      "background-origin",
      "background-position",
      "background-position-x",
      "background-position-y",
      "background-repeat",
      "background-size",
      "baseline-shift",
      "block-size",
      "border",
      "border-block",
      "border-block-color",
      "border-block-end",
      "border-block-end-color",
      "border-block-end-style",
      "border-block-end-width",
      "border-block-start",
      "border-block-start-color",
      "border-block-start-style",
      "border-block-start-width",
      "border-block-style",
      "border-block-width",
      "border-bottom",
      "border-bottom-color",
      "border-bottom-left-radius",
      "border-bottom-right-radius",
      "border-bottom-style",
      "border-bottom-width",
      "border-collapse",
      "border-color",
      "border-end-end-radius",
      "border-end-start-radius",
      "border-image",
      "border-image-outset",
      "border-image-repeat",
      "border-image-slice",
      "border-image-source",
      "border-image-width",
      "border-inline",
      "border-inline-color",
      "border-inline-end",
      "border-inline-end-color",
      "border-inline-end-style",
      "border-inline-end-width",
      "border-inline-start",
      "border-inline-start-color",
      "border-inline-start-style",
      "border-inline-start-width",
      "border-inline-style",
      "border-inline-width",
      "border-left",
      "border-left-color",
      "border-left-style",
      "border-left-width",
      "border-radius",
      "border-right",
      "border-right-color",
      "border-right-style",
      "border-right-width",
      "border-spacing",
      "border-start-end-radius",
      "border-start-start-radius",
      "border-style",
      "border-top",
      "border-top-color",
      "border-top-left-radius",
      "border-top-right-radius",
      "border-top-style",
      "border-top-width",
      "border-width",
      "bottom",
      "box-align",
      "box-decoration-break",
      "box-direction",
      "box-flex",
      "box-flex-group",
      "box-lines",
      "box-ordinal-group",
      "box-orient",
      "box-pack",
      "box-shadow",
      "box-sizing",
      "break-after",
      "break-before",
      "break-inside",
      "caption-side",
      "caret-color",
      "clear",
      "clip",
      "clip-path",
      "clip-rule",
      "color",
      "color-interpolation",
      "color-interpolation-filters",
      "color-profile",
      "color-rendering",
      "color-scheme",
      "column-count",
      "column-fill",
      "column-gap",
      "column-rule",
      "column-rule-color",
      "column-rule-style",
      "column-rule-width",
      "column-span",
      "column-width",
      "columns",
      "contain",
      "contain-intrinsic-block-size",
      "contain-intrinsic-height",
      "contain-intrinsic-inline-size",
      "contain-intrinsic-size",
      "contain-intrinsic-width",
      "container",
      "container-name",
      "container-type",
      "content",
      "content-visibility",
      "counter-increment",
      "counter-reset",
      "counter-set",
      "cue",
      "cue-after",
      "cue-before",
      "cursor",
      "cx",
      "cy",
      "direction",
      "display",
      "dominant-baseline",
      "empty-cells",
      "enable-background",
      "field-sizing",
      "fill",
      "fill-opacity",
      "fill-rule",
      "filter",
      "flex",
      "flex-basis",
      "flex-direction",
      "flex-flow",
      "flex-grow",
      "flex-shrink",
      "flex-wrap",
      "float",
      "flood-color",
      "flood-opacity",
      "flow",
      "font",
      "font-display",
      "font-family",
      "font-feature-settings",
      "font-kerning",
      "font-language-override",
      "font-optical-sizing",
      "font-palette",
      "font-size",
      "font-size-adjust",
      "font-smooth",
      "font-smoothing",
      "font-stretch",
      "font-style",
      "font-synthesis",
      "font-synthesis-position",
      "font-synthesis-small-caps",
      "font-synthesis-style",
      "font-synthesis-weight",
      "font-variant",
      "font-variant-alternates",
      "font-variant-caps",
      "font-variant-east-asian",
      "font-variant-emoji",
      "font-variant-ligatures",
      "font-variant-numeric",
      "font-variant-position",
      "font-variation-settings",
      "font-weight",
      "forced-color-adjust",
      "gap",
      "glyph-orientation-horizontal",
      "glyph-orientation-vertical",
      "grid",
      "grid-area",
      "grid-auto-columns",
      "grid-auto-flow",
      "grid-auto-rows",
      "grid-column",
      "grid-column-end",
      "grid-column-start",
      "grid-gap",
      "grid-row",
      "grid-row-end",
      "grid-row-start",
      "grid-template",
      "grid-template-areas",
      "grid-template-columns",
      "grid-template-rows",
      "hanging-punctuation",
      "height",
      "hyphenate-character",
      "hyphenate-limit-chars",
      "hyphens",
      "icon",
      "image-orientation",
      "image-rendering",
      "image-resolution",
      "ime-mode",
      "initial-letter",
      "initial-letter-align",
      "inline-size",
      "inset",
      "inset-area",
      "inset-block",
      "inset-block-end",
      "inset-block-start",
      "inset-inline",
      "inset-inline-end",
      "inset-inline-start",
      "isolation",
      "justify-content",
      "justify-items",
      "justify-self",
      "kerning",
      "left",
      "letter-spacing",
      "lighting-color",
      "line-break",
      "line-height",
      "line-height-step",
      "list-style",
      "list-style-image",
      "list-style-position",
      "list-style-type",
      "margin",
      "margin-block",
      "margin-block-end",
      "margin-block-start",
      "margin-bottom",
      "margin-inline",
      "margin-inline-end",
      "margin-inline-start",
      "margin-left",
      "margin-right",
      "margin-top",
      "margin-trim",
      "marker",
      "marker-end",
      "marker-mid",
      "marker-start",
      "marks",
      "mask",
      "mask-border",
      "mask-border-mode",
      "mask-border-outset",
      "mask-border-repeat",
      "mask-border-slice",
      "mask-border-source",
      "mask-border-width",
      "mask-clip",
      "mask-composite",
      "mask-image",
      "mask-mode",
      "mask-origin",
      "mask-position",
      "mask-repeat",
      "mask-size",
      "mask-type",
      "masonry-auto-flow",
      "math-depth",
      "math-shift",
      "math-style",
      "max-block-size",
      "max-height",
      "max-inline-size",
      "max-width",
      "min-block-size",
      "min-height",
      "min-inline-size",
      "min-width",
      "mix-blend-mode",
      "nav-down",
      "nav-index",
      "nav-left",
      "nav-right",
      "nav-up",
      "none",
      "normal",
      "object-fit",
      "object-position",
      "offset",
      "offset-anchor",
      "offset-distance",
      "offset-path",
      "offset-position",
      "offset-rotate",
      "opacity",
      "order",
      "orphans",
      "outline",
      "outline-color",
      "outline-offset",
      "outline-style",
      "outline-width",
      "overflow",
      "overflow-anchor",
      "overflow-block",
      "overflow-clip-margin",
      "overflow-inline",
      "overflow-wrap",
      "overflow-x",
      "overflow-y",
      "overlay",
      "overscroll-behavior",
      "overscroll-behavior-block",
      "overscroll-behavior-inline",
      "overscroll-behavior-x",
      "overscroll-behavior-y",
      "padding",
      "padding-block",
      "padding-block-end",
      "padding-block-start",
      "padding-bottom",
      "padding-inline",
      "padding-inline-end",
      "padding-inline-start",
      "padding-left",
      "padding-right",
      "padding-top",
      "page",
      "page-break-after",
      "page-break-before",
      "page-break-inside",
      "paint-order",
      "pause",
      "pause-after",
      "pause-before",
      "perspective",
      "perspective-origin",
      "place-content",
      "place-items",
      "place-self",
      "pointer-events",
      "position",
      "position-anchor",
      "position-visibility",
      "print-color-adjust",
      "quotes",
      "r",
      "resize",
      "rest",
      "rest-after",
      "rest-before",
      "right",
      "rotate",
      "row-gap",
      "ruby-align",
      "ruby-position",
      "scale",
      "scroll-behavior",
      "scroll-margin",
      "scroll-margin-block",
      "scroll-margin-block-end",
      "scroll-margin-block-start",
      "scroll-margin-bottom",
      "scroll-margin-inline",
      "scroll-margin-inline-end",
      "scroll-margin-inline-start",
      "scroll-margin-left",
      "scroll-margin-right",
      "scroll-margin-top",
      "scroll-padding",
      "scroll-padding-block",
      "scroll-padding-block-end",
      "scroll-padding-block-start",
      "scroll-padding-bottom",
      "scroll-padding-inline",
      "scroll-padding-inline-end",
      "scroll-padding-inline-start",
      "scroll-padding-left",
      "scroll-padding-right",
      "scroll-padding-top",
      "scroll-snap-align",
      "scroll-snap-stop",
      "scroll-snap-type",
      "scroll-timeline",
      "scroll-timeline-axis",
      "scroll-timeline-name",
      "scrollbar-color",
      "scrollbar-gutter",
      "scrollbar-width",
      "shape-image-threshold",
      "shape-margin",
      "shape-outside",
      "shape-rendering",
      "speak",
      "speak-as",
      "src",
      // @font-face
      "stop-color",
      "stop-opacity",
      "stroke",
      "stroke-dasharray",
      "stroke-dashoffset",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-miterlimit",
      "stroke-opacity",
      "stroke-width",
      "tab-size",
      "table-layout",
      "text-align",
      "text-align-all",
      "text-align-last",
      "text-anchor",
      "text-combine-upright",
      "text-decoration",
      "text-decoration-color",
      "text-decoration-line",
      "text-decoration-skip",
      "text-decoration-skip-ink",
      "text-decoration-style",
      "text-decoration-thickness",
      "text-emphasis",
      "text-emphasis-color",
      "text-emphasis-position",
      "text-emphasis-style",
      "text-indent",
      "text-justify",
      "text-orientation",
      "text-overflow",
      "text-rendering",
      "text-shadow",
      "text-size-adjust",
      "text-transform",
      "text-underline-offset",
      "text-underline-position",
      "text-wrap",
      "text-wrap-mode",
      "text-wrap-style",
      "timeline-scope",
      "top",
      "touch-action",
      "transform",
      "transform-box",
      "transform-origin",
      "transform-style",
      "transition",
      "transition-behavior",
      "transition-delay",
      "transition-duration",
      "transition-property",
      "transition-timing-function",
      "translate",
      "unicode-bidi",
      "user-modify",
      "user-select",
      "vector-effect",
      "vertical-align",
      "view-timeline",
      "view-timeline-axis",
      "view-timeline-inset",
      "view-timeline-name",
      "view-transition-name",
      "visibility",
      "voice-balance",
      "voice-duration",
      "voice-family",
      "voice-pitch",
      "voice-range",
      "voice-rate",
      "voice-stress",
      "voice-volume",
      "white-space",
      "white-space-collapse",
      "widows",
      "width",
      "will-change",
      "word-break",
      "word-spacing",
      "word-wrap",
      "writing-mode",
      "x",
      "y",
      "z-index",
      "zoom"
    ].sort().reverse();
    var PSEUDO_SELECTORS = PSEUDO_CLASSES.concat(PSEUDO_ELEMENTS).sort().reverse();
    function less(hljs) {
      const modes = MODES(hljs);
      const PSEUDO_SELECTORS$1 = PSEUDO_SELECTORS;
      const AT_MODIFIERS = "and or not only";
      const IDENT_RE = "[\\w-]+";
      const INTERP_IDENT_RE = "(" + IDENT_RE + "|@\\{" + IDENT_RE + "\\})";
      const RULES = [];
      const VALUE_MODES = [];
      const STRING_MODE = function(c4) {
        return {
          // Less strings are not multiline (also include '~' for more consistent coloring of "escaped" strings)
          className: "string",
          begin: "~?" + c4 + ".*?" + c4
        };
      };
      const IDENT_MODE = function(name, begin, relevance) {
        return {
          className: name,
          begin,
          relevance
        };
      };
      const AT_KEYWORDS = {
        $pattern: /[a-z-]+/,
        keyword: AT_MODIFIERS,
        attribute: MEDIA_FEATURES.join(" ")
      };
      const PARENS_MODE = {
        // used only to properly balance nested parens inside mixin call, def. arg list
        begin: "\\(",
        end: "\\)",
        contains: VALUE_MODES,
        keywords: AT_KEYWORDS,
        relevance: 0
      };
      VALUE_MODES.push(
        hljs.C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        STRING_MODE("'"),
        STRING_MODE('"'),
        modes.CSS_NUMBER_MODE,
        // fixme: it does not include dot for numbers like .5em :(
        {
          begin: "(url|data-uri)\\(",
          starts: {
            className: "string",
            end: "[\\)\\n]",
            excludeEnd: true
          }
        },
        modes.HEXCOLOR,
        PARENS_MODE,
        IDENT_MODE("variable", "@@?" + IDENT_RE, 10),
        IDENT_MODE("variable", "@\\{" + IDENT_RE + "\\}"),
        IDENT_MODE("built_in", "~?`[^`]*?`"),
        // inline javascript (or whatever host language) *multiline* string
        {
          // @media features (it’s here to not duplicate things in AT_RULE_MODE with extra PARENS_MODE overriding):
          className: "attribute",
          begin: IDENT_RE + "\\s*:",
          end: ":",
          returnBegin: true,
          excludeEnd: true
        },
        modes.IMPORTANT,
        { beginKeywords: "and not" },
        modes.FUNCTION_DISPATCH
      );
      const VALUE_WITH_RULESETS = VALUE_MODES.concat({
        begin: /\{/,
        end: /\}/,
        contains: RULES
      });
      const MIXIN_GUARD_MODE = {
        beginKeywords: "when",
        endsWithParent: true,
        contains: [{ beginKeywords: "and not" }].concat(VALUE_MODES)
        // using this form to override VALUE’s 'function' match
      };
      const RULE_MODE = {
        begin: INTERP_IDENT_RE + "\\s*:",
        returnBegin: true,
        end: /[;}]/,
        relevance: 0,
        contains: [
          { begin: /-(webkit|moz|ms|o)-/ },
          modes.CSS_VARIABLE,
          {
            className: "attribute",
            begin: "\\b(" + ATTRIBUTES.join("|") + ")\\b",
            end: /(?=:)/,
            starts: {
              endsWithParent: true,
              illegal: "[<=$]",
              relevance: 0,
              contains: VALUE_MODES
            }
          }
        ]
      };
      const AT_RULE_MODE = {
        className: "keyword",
        begin: "@(import|media|charset|font-face|(-[a-z]+-)?keyframes|supports|document|namespace|page|viewport|host)\\b",
        starts: {
          end: "[;{}]",
          keywords: AT_KEYWORDS,
          returnEnd: true,
          contains: VALUE_MODES,
          relevance: 0
        }
      };
      const VAR_RULE_MODE = {
        className: "variable",
        variants: [
          // using more strict pattern for higher relevance to increase chances of Less detection.
          // this is *the only* Less specific statement used in most of the sources, so...
          // (we’ll still often loose to the css-parser unless there's '//' comment,
          // simply because 1 variable just can't beat 99 properties :)
          {
            begin: "@" + IDENT_RE + "\\s*:",
            relevance: 15
          },
          { begin: "@" + IDENT_RE }
        ],
        starts: {
          end: "[;}]",
          returnEnd: true,
          contains: VALUE_WITH_RULESETS
        }
      };
      const SELECTOR_MODE = {
        // first parse unambiguous selectors (i.e. those not starting with tag)
        // then fall into the scary lookahead-discriminator variant.
        // this mode also handles mixin definitions and calls
        variants: [
          {
            begin: "[\\.#:&\\[>]",
            end: "[;{}]"
            // mixin calls end with ';'
          },
          {
            begin: INTERP_IDENT_RE,
            end: /\{/
          }
        ],
        returnBegin: true,
        returnEnd: true,
        illegal: `[<='$"]`,
        relevance: 0,
        contains: [
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          MIXIN_GUARD_MODE,
          IDENT_MODE("keyword", "all\\b"),
          IDENT_MODE("variable", "@\\{" + IDENT_RE + "\\}"),
          // otherwise it’s identified as tag
          {
            begin: "\\b(" + TAGS.join("|") + ")\\b",
            className: "selector-tag"
          },
          modes.CSS_NUMBER_MODE,
          IDENT_MODE("selector-tag", INTERP_IDENT_RE, 0),
          IDENT_MODE("selector-id", "#" + INTERP_IDENT_RE),
          IDENT_MODE("selector-class", "\\." + INTERP_IDENT_RE, 0),
          IDENT_MODE("selector-tag", "&", 0),
          modes.ATTRIBUTE_SELECTOR_MODE,
          {
            className: "selector-pseudo",
            begin: ":(" + PSEUDO_CLASSES.join("|") + ")"
          },
          {
            className: "selector-pseudo",
            begin: ":(:)?(" + PSEUDO_ELEMENTS.join("|") + ")"
          },
          {
            begin: /\(/,
            end: /\)/,
            relevance: 0,
            contains: VALUE_WITH_RULESETS
          },
          // argument list of parametric mixins
          { begin: "!important" },
          // eat !important after mixin call or it will be colored as tag
          modes.FUNCTION_DISPATCH
        ]
      };
      const PSEUDO_SELECTOR_MODE = {
        begin: IDENT_RE + `:(:)?(${PSEUDO_SELECTORS$1.join("|")})`,
        returnBegin: true,
        contains: [SELECTOR_MODE]
      };
      RULES.push(
        hljs.C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        AT_RULE_MODE,
        VAR_RULE_MODE,
        PSEUDO_SELECTOR_MODE,
        RULE_MODE,
        SELECTOR_MODE,
        MIXIN_GUARD_MODE,
        modes.FUNCTION_DISPATCH
      );
      return {
        name: "Less",
        case_insensitive: true,
        illegal: `[=>'/<($"]`,
        contains: RULES
      };
    }
    module.exports = less;
  }
});

// node_modules/highlight.js/lib/languages/lua.js
var require_lua = __commonJS({
  "node_modules/highlight.js/lib/languages/lua.js"(exports, module) {
    function lua(hljs) {
      const OPENING_LONG_BRACKET = "\\[=*\\[";
      const CLOSING_LONG_BRACKET = "\\]=*\\]";
      const LONG_BRACKETS = {
        begin: OPENING_LONG_BRACKET,
        end: CLOSING_LONG_BRACKET,
        contains: ["self"]
      };
      const COMMENTS = [
        hljs.COMMENT("--(?!" + OPENING_LONG_BRACKET + ")", "$"),
        hljs.COMMENT(
          "--" + OPENING_LONG_BRACKET,
          CLOSING_LONG_BRACKET,
          {
            contains: [LONG_BRACKETS],
            relevance: 10
          }
        )
      ];
      return {
        name: "Lua",
        aliases: ["pluto"],
        keywords: {
          $pattern: hljs.UNDERSCORE_IDENT_RE,
          literal: "true false nil",
          keyword: "and break do else elseif end for goto if in local not or repeat return then until while",
          built_in: (
            // Metatags and globals:
            "_G _ENV _VERSION __index __newindex __mode __call __metatable __tostring __len __gc __add __sub __mul __div __mod __pow __concat __unm __eq __lt __le assert collectgarbage dofile error getfenv getmetatable ipairs load loadfile loadstring module next pairs pcall print rawequal rawget rawset require select setfenv setmetatable tonumber tostring type unpack xpcall arg self coroutine resume yield status wrap create running debug getupvalue debug sethook getmetatable gethook setmetatable setlocal traceback setfenv getinfo setupvalue getlocal getregistry getfenv io lines write close flush open output type read stderr stdin input stdout popen tmpfile math log max acos huge ldexp pi cos tanh pow deg tan cosh sinh random randomseed frexp ceil floor rad abs sqrt modf asin min mod fmod log10 atan2 exp sin atan os exit setlocale date getenv difftime remove time clock tmpname rename execute package preload loadlib loaded loaders cpath config path seeall string sub upper len gfind rep find match char dump gmatch reverse byte format gsub lower table setn insert getn foreachi maxn foreach concat sort remove"
          )
        },
        contains: COMMENTS.concat([
          {
            className: "function",
            beginKeywords: "function",
            end: "\\)",
            contains: [
              hljs.inherit(hljs.TITLE_MODE, { begin: "([_a-zA-Z]\\w*\\.)*([_a-zA-Z]\\w*:)?[_a-zA-Z]\\w*" }),
              {
                className: "params",
                begin: "\\(",
                endsWithParent: true,
                contains: COMMENTS
              }
            ].concat(COMMENTS)
          },
          hljs.C_NUMBER_MODE,
          hljs.APOS_STRING_MODE,
          hljs.QUOTE_STRING_MODE,
          {
            className: "string",
            begin: OPENING_LONG_BRACKET,
            end: CLOSING_LONG_BRACKET,
            contains: [LONG_BRACKETS],
            relevance: 5
          }
        ])
      };
    }
    module.exports = lua;
  }
});

// node_modules/highlight.js/lib/languages/makefile.js
var require_makefile = __commonJS({
  "node_modules/highlight.js/lib/languages/makefile.js"(exports, module) {
    function makefile(hljs) {
      const VARIABLE = {
        className: "variable",
        variants: [
          {
            begin: "\\$\\(" + hljs.UNDERSCORE_IDENT_RE + "\\)",
            contains: [hljs.BACKSLASH_ESCAPE]
          },
          { begin: /\$[@%<?\^\+\*]/ }
        ]
      };
      const QUOTE_STRING = {
        className: "string",
        begin: /"/,
        end: /"/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          VARIABLE
        ]
      };
      const FUNC = {
        className: "variable",
        begin: /\$\([\w-]+\s/,
        end: /\)/,
        keywords: { built_in: "subst patsubst strip findstring filter filter-out sort word wordlist firstword lastword dir notdir suffix basename addsuffix addprefix join wildcard realpath abspath error warning shell origin flavor foreach if or and call eval file value" },
        contains: [
          VARIABLE,
          QUOTE_STRING
          // Added QUOTE_STRING as they can be a part of functions
        ]
      };
      const ASSIGNMENT = { begin: "^" + hljs.UNDERSCORE_IDENT_RE + "\\s*(?=[:+?]?=)" };
      const META = {
        className: "meta",
        begin: /^\.PHONY:/,
        end: /$/,
        keywords: {
          $pattern: /[\.\w]+/,
          keyword: ".PHONY"
        }
      };
      const TARGET = {
        className: "section",
        begin: /^[^\s]+:/,
        end: /$/,
        contains: [VARIABLE]
      };
      return {
        name: "Makefile",
        aliases: [
          "mk",
          "mak",
          "make"
        ],
        keywords: {
          $pattern: /[\w-]+/,
          keyword: "define endef undefine ifdef ifndef ifeq ifneq else endif include -include sinclude override export unexport private vpath"
        },
        contains: [
          hljs.HASH_COMMENT_MODE,
          VARIABLE,
          QUOTE_STRING,
          FUNC,
          ASSIGNMENT,
          META,
          TARGET
        ]
      };
    }
    module.exports = makefile;
  }
});

// node_modules/highlight.js/lib/languages/perl.js
var require_perl = __commonJS({
  "node_modules/highlight.js/lib/languages/perl.js"(exports, module) {
    function perl(hljs) {
      const regex = hljs.regex;
      const KEYWORDS = [
        "abs",
        "accept",
        "alarm",
        "and",
        "atan2",
        "bind",
        "binmode",
        "bless",
        "break",
        "caller",
        "chdir",
        "chmod",
        "chomp",
        "chop",
        "chown",
        "chr",
        "chroot",
        "class",
        "close",
        "closedir",
        "connect",
        "continue",
        "cos",
        "crypt",
        "dbmclose",
        "dbmopen",
        "defined",
        "delete",
        "die",
        "do",
        "dump",
        "each",
        "else",
        "elsif",
        "endgrent",
        "endhostent",
        "endnetent",
        "endprotoent",
        "endpwent",
        "endservent",
        "eof",
        "eval",
        "exec",
        "exists",
        "exit",
        "exp",
        "fcntl",
        "field",
        "fileno",
        "flock",
        "for",
        "foreach",
        "fork",
        "format",
        "formline",
        "getc",
        "getgrent",
        "getgrgid",
        "getgrnam",
        "gethostbyaddr",
        "gethostbyname",
        "gethostent",
        "getlogin",
        "getnetbyaddr",
        "getnetbyname",
        "getnetent",
        "getpeername",
        "getpgrp",
        "getpriority",
        "getprotobyname",
        "getprotobynumber",
        "getprotoent",
        "getpwent",
        "getpwnam",
        "getpwuid",
        "getservbyname",
        "getservbyport",
        "getservent",
        "getsockname",
        "getsockopt",
        "given",
        "glob",
        "gmtime",
        "goto",
        "grep",
        "gt",
        "hex",
        "if",
        "index",
        "int",
        "ioctl",
        "join",
        "keys",
        "kill",
        "last",
        "lc",
        "lcfirst",
        "length",
        "link",
        "listen",
        "local",
        "localtime",
        "log",
        "lstat",
        "lt",
        "ma",
        "map",
        "method",
        "mkdir",
        "msgctl",
        "msgget",
        "msgrcv",
        "msgsnd",
        "my",
        "ne",
        "next",
        "no",
        "not",
        "oct",
        "open",
        "opendir",
        "or",
        "ord",
        "our",
        "pack",
        "package",
        "pipe",
        "pop",
        "pos",
        "print",
        "printf",
        "prototype",
        "push",
        "q|0",
        "qq",
        "quotemeta",
        "qw",
        "qx",
        "rand",
        "read",
        "readdir",
        "readline",
        "readlink",
        "readpipe",
        "recv",
        "redo",
        "ref",
        "rename",
        "require",
        "reset",
        "return",
        "reverse",
        "rewinddir",
        "rindex",
        "rmdir",
        "say",
        "scalar",
        "seek",
        "seekdir",
        "select",
        "semctl",
        "semget",
        "semop",
        "send",
        "setgrent",
        "sethostent",
        "setnetent",
        "setpgrp",
        "setpriority",
        "setprotoent",
        "setpwent",
        "setservent",
        "setsockopt",
        "shift",
        "shmctl",
        "shmget",
        "shmread",
        "shmwrite",
        "shutdown",
        "sin",
        "sleep",
        "socket",
        "socketpair",
        "sort",
        "splice",
        "split",
        "sprintf",
        "sqrt",
        "srand",
        "stat",
        "state",
        "study",
        "sub",
        "substr",
        "symlink",
        "syscall",
        "sysopen",
        "sysread",
        "sysseek",
        "system",
        "syswrite",
        "tell",
        "telldir",
        "tie",
        "tied",
        "time",
        "times",
        "tr",
        "truncate",
        "uc",
        "ucfirst",
        "umask",
        "undef",
        "unless",
        "unlink",
        "unpack",
        "unshift",
        "untie",
        "until",
        "use",
        "utime",
        "values",
        "vec",
        "wait",
        "waitpid",
        "wantarray",
        "warn",
        "when",
        "while",
        "write",
        "x|0",
        "xor",
        "y|0"
      ];
      const REGEX_MODIFIERS = /[dualxmsipngr]{0,12}/;
      const PERL_KEYWORDS = {
        $pattern: /[\w.]+/,
        keyword: KEYWORDS.join(" ")
      };
      const SUBST = {
        className: "subst",
        begin: "[$@]\\{",
        end: "\\}",
        keywords: PERL_KEYWORDS
      };
      const METHOD = {
        begin: /->\{/,
        end: /\}/
        // contains defined later
      };
      const ATTR = {
        scope: "attr",
        match: /\s+:\s*\w+(\s*\(.*?\))?/
      };
      const VAR = {
        scope: "variable",
        variants: [
          { begin: /\$\d/ },
          {
            begin: regex.concat(
              /[$%@](?!")(\^\w\b|#\w+(::\w+)*|\{\w+\}|\w+(::\w*)*)/,
              // negative look-ahead tries to avoid matching patterns that are not
              // Perl at all like $ident$, @ident@, etc.
              `(?![A-Za-z])(?![@$%])`
            )
          },
          {
            // Only $= is a special Perl variable and one can't declare @= or %=.
            begin: /[$%@](?!")[^\s\w{=]|\$=/,
            relevance: 0
          }
        ],
        contains: [ATTR]
      };
      const NUMBER = {
        className: "number",
        variants: [
          // decimal numbers:
          // include the case where a number starts with a dot (eg. .9), and
          // the leading 0? avoids mixing the first and second match on 0.x cases
          { match: /0?\.[0-9][0-9_]+\b/ },
          // include the special versioned number (eg. v5.38)
          { match: /\bv?(0|[1-9][0-9_]*(\.[0-9_]+)?|[1-9][0-9_]*)\b/ },
          // non-decimal numbers:
          { match: /\b0[0-7][0-7_]*\b/ },
          { match: /\b0x[0-9a-fA-F][0-9a-fA-F_]*\b/ },
          { match: /\b0b[0-1][0-1_]*\b/ }
        ],
        relevance: 0
      };
      const STRING_CONTAINS = [
        hljs.BACKSLASH_ESCAPE,
        SUBST,
        VAR
      ];
      const REGEX_DELIMS = [
        /!/,
        /\//,
        /\|/,
        /\?/,
        /'/,
        /"/,
        // valid but infrequent and weird
        /#/
        // valid but infrequent and weird
      ];
      const PAIRED_DOUBLE_RE = (prefix, open, close = "\\1") => {
        const middle = close === "\\1" ? close : regex.concat(close, open);
        return regex.concat(
          regex.concat("(?:", prefix, ")"),
          open,
          /(?:\\.|[^\\\/])*?/,
          middle,
          /(?:\\.|[^\\\/])*?/,
          close,
          REGEX_MODIFIERS
        );
      };
      const PAIRED_RE = (prefix, open, close) => {
        return regex.concat(
          regex.concat("(?:", prefix, ")"),
          open,
          /(?:\\.|[^\\\/])*?/,
          close,
          REGEX_MODIFIERS
        );
      };
      const PERL_DEFAULT_CONTAINS = [
        VAR,
        hljs.HASH_COMMENT_MODE,
        hljs.COMMENT(
          /^=\w/,
          /=cut/,
          { endsWithParent: true }
        ),
        METHOD,
        {
          className: "string",
          contains: STRING_CONTAINS,
          variants: [
            {
              begin: "q[qwxr]?\\s*\\(",
              end: "\\)",
              relevance: 5
            },
            {
              begin: "q[qwxr]?\\s*\\[",
              end: "\\]",
              relevance: 5
            },
            {
              begin: "q[qwxr]?\\s*\\{",
              end: "\\}",
              relevance: 5
            },
            {
              begin: "q[qwxr]?\\s*\\|",
              end: "\\|",
              relevance: 5
            },
            {
              begin: "q[qwxr]?\\s*<",
              end: ">",
              relevance: 5
            },
            {
              begin: "qw\\s+q",
              end: "q",
              relevance: 5
            },
            {
              begin: "'",
              end: "'",
              contains: [hljs.BACKSLASH_ESCAPE]
            },
            {
              begin: '"',
              end: '"'
            },
            {
              begin: "`",
              end: "`",
              contains: [hljs.BACKSLASH_ESCAPE]
            },
            {
              begin: /\{\w+\}/,
              relevance: 0
            },
            {
              begin: "-?\\w+\\s*=>",
              relevance: 0
            }
          ]
        },
        NUMBER,
        {
          // regexp container
          begin: "(\\/\\/|" + hljs.RE_STARTERS_RE + "|\\b(split|return|print|reverse|grep)\\b)\\s*",
          keywords: "split return print reverse grep",
          relevance: 0,
          contains: [
            hljs.HASH_COMMENT_MODE,
            {
              className: "regexp",
              variants: [
                // allow matching common delimiters
                { begin: PAIRED_DOUBLE_RE("s|tr|y", regex.either(...REGEX_DELIMS, { capture: true })) },
                // and then paired delmis
                { begin: PAIRED_DOUBLE_RE("s|tr|y", "\\(", "\\)") },
                { begin: PAIRED_DOUBLE_RE("s|tr|y", "\\[", "\\]") },
                { begin: PAIRED_DOUBLE_RE("s|tr|y", "\\{", "\\}") }
              ],
              relevance: 2
            },
            {
              className: "regexp",
              variants: [
                {
                  // could be a comment in many languages so do not count
                  // as relevant
                  begin: /(m|qr)\/\//,
                  relevance: 0
                },
                // prefix is optional with /regex/
                { begin: PAIRED_RE("(?:m|qr)?", /\//, /\//) },
                // allow matching common delimiters
                { begin: PAIRED_RE("m|qr", regex.either(...REGEX_DELIMS, { capture: true }), /\1/) },
                // allow common paired delmins
                { begin: PAIRED_RE("m|qr", /\(/, /\)/) },
                { begin: PAIRED_RE("m|qr", /\[/, /\]/) },
                { begin: PAIRED_RE("m|qr", /\{/, /\}/) }
              ]
            }
          ]
        },
        {
          className: "function",
          beginKeywords: "sub method",
          end: "(\\s*\\(.*?\\))?[;{]",
          excludeEnd: true,
          relevance: 5,
          contains: [hljs.TITLE_MODE, ATTR]
        },
        {
          className: "class",
          beginKeywords: "class",
          end: "[;{]",
          excludeEnd: true,
          relevance: 5,
          contains: [hljs.TITLE_MODE, ATTR, NUMBER]
        },
        {
          begin: "-\\w\\b",
          relevance: 0
        },
        {
          begin: "^__DATA__$",
          end: "^__END__$",
          subLanguage: "mojolicious",
          contains: [
            {
              begin: "^@@.*",
              end: "$",
              className: "comment"
            }
          ]
        }
      ];
      SUBST.contains = PERL_DEFAULT_CONTAINS;
      METHOD.contains = PERL_DEFAULT_CONTAINS;
      return {
        name: "Perl",
        aliases: [
          "pl",
          "pm"
        ],
        keywords: PERL_KEYWORDS,
        contains: PERL_DEFAULT_CONTAINS
      };
    }
    module.exports = perl;
  }
});

// node_modules/highlight.js/lib/languages/objectivec.js
var require_objectivec = __commonJS({
  "node_modules/highlight.js/lib/languages/objectivec.js"(exports, module) {
    function objectivec(hljs) {
      const API_CLASS = {
        className: "built_in",
        begin: "\\b(AV|CA|CF|CG|CI|CL|CM|CN|CT|MK|MP|MTK|MTL|NS|SCN|SK|UI|WK|XC)\\w+"
      };
      const IDENTIFIER_RE = /[a-zA-Z@][a-zA-Z0-9_]*/;
      const TYPES = [
        "int",
        "float",
        "char",
        "unsigned",
        "signed",
        "short",
        "long",
        "double",
        "wchar_t",
        "unichar",
        "void",
        "bool",
        "BOOL",
        "id|0",
        "_Bool"
      ];
      const KWS = [
        "while",
        "export",
        "sizeof",
        "typedef",
        "const",
        "struct",
        "for",
        "union",
        "volatile",
        "static",
        "mutable",
        "if",
        "do",
        "return",
        "goto",
        "enum",
        "else",
        "break",
        "extern",
        "asm",
        "case",
        "default",
        "register",
        "explicit",
        "typename",
        "switch",
        "continue",
        "inline",
        "readonly",
        "assign",
        "readwrite",
        "self",
        "@synchronized",
        "id",
        "typeof",
        "nonatomic",
        "IBOutlet",
        "IBAction",
        "strong",
        "weak",
        "copy",
        "in",
        "out",
        "inout",
        "bycopy",
        "byref",
        "oneway",
        "__strong",
        "__weak",
        "__block",
        "__autoreleasing",
        "@private",
        "@protected",
        "@public",
        "@try",
        "@property",
        "@end",
        "@throw",
        "@catch",
        "@finally",
        "@autoreleasepool",
        "@synthesize",
        "@dynamic",
        "@selector",
        "@optional",
        "@required",
        "@encode",
        "@package",
        "@import",
        "@defs",
        "@compatibility_alias",
        "__bridge",
        "__bridge_transfer",
        "__bridge_retained",
        "__bridge_retain",
        "__covariant",
        "__contravariant",
        "__kindof",
        "_Nonnull",
        "_Nullable",
        "_Null_unspecified",
        "__FUNCTION__",
        "__PRETTY_FUNCTION__",
        "__attribute__",
        "getter",
        "setter",
        "retain",
        "unsafe_unretained",
        "nonnull",
        "nullable",
        "null_unspecified",
        "null_resettable",
        "class",
        "instancetype",
        "NS_DESIGNATED_INITIALIZER",
        "NS_UNAVAILABLE",
        "NS_REQUIRES_SUPER",
        "NS_RETURNS_INNER_POINTER",
        "NS_INLINE",
        "NS_AVAILABLE",
        "NS_DEPRECATED",
        "NS_ENUM",
        "NS_OPTIONS",
        "NS_SWIFT_UNAVAILABLE",
        "NS_ASSUME_NONNULL_BEGIN",
        "NS_ASSUME_NONNULL_END",
        "NS_REFINED_FOR_SWIFT",
        "NS_SWIFT_NAME",
        "NS_SWIFT_NOTHROW",
        "NS_DURING",
        "NS_HANDLER",
        "NS_ENDHANDLER",
        "NS_VALUERETURN",
        "NS_VOIDRETURN"
      ];
      const LITERALS = [
        "false",
        "true",
        "FALSE",
        "TRUE",
        "nil",
        "YES",
        "NO",
        "NULL"
      ];
      const BUILT_INS = [
        "dispatch_once_t",
        "dispatch_queue_t",
        "dispatch_sync",
        "dispatch_async",
        "dispatch_once"
      ];
      const KEYWORDS = {
        "variable.language": [
          "this",
          "super"
        ],
        $pattern: IDENTIFIER_RE,
        keyword: KWS,
        literal: LITERALS,
        built_in: BUILT_INS,
        type: TYPES
      };
      const CLASS_KEYWORDS = {
        $pattern: IDENTIFIER_RE,
        keyword: [
          "@interface",
          "@class",
          "@protocol",
          "@implementation"
        ]
      };
      return {
        name: "Objective-C",
        aliases: [
          "mm",
          "objc",
          "obj-c",
          "obj-c++",
          "objective-c++"
        ],
        keywords: KEYWORDS,
        illegal: "</",
        contains: [
          API_CLASS,
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          hljs.C_NUMBER_MODE,
          hljs.QUOTE_STRING_MODE,
          hljs.APOS_STRING_MODE,
          {
            className: "string",
            variants: [
              {
                begin: '@"',
                end: '"',
                illegal: "\\n",
                contains: [hljs.BACKSLASH_ESCAPE]
              }
            ]
          },
          {
            className: "meta",
            begin: /#\s*[a-z]+\b/,
            end: /$/,
            keywords: { keyword: "if else elif endif define undef warning error line pragma ifdef ifndef include" },
            contains: [
              {
                begin: /\\\n/,
                relevance: 0
              },
              hljs.inherit(hljs.QUOTE_STRING_MODE, { className: "string" }),
              {
                className: "string",
                begin: /<.*?>/,
                end: /$/,
                illegal: "\\n"
              },
              hljs.C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE
            ]
          },
          {
            className: "class",
            begin: "(" + CLASS_KEYWORDS.keyword.join("|") + ")\\b",
            end: /(\{|$)/,
            excludeEnd: true,
            keywords: CLASS_KEYWORDS,
            contains: [hljs.UNDERSCORE_TITLE_MODE]
          },
          {
            begin: "\\." + hljs.UNDERSCORE_IDENT_RE,
            relevance: 0
          }
        ]
      };
    }
    module.exports = objectivec;
  }
});

// node_modules/highlight.js/lib/languages/php.js
var require_php = __commonJS({
  "node_modules/highlight.js/lib/languages/php.js"(exports, module) {
    function php(hljs) {
      const regex = hljs.regex;
      const NOT_PERL_ETC = /(?![A-Za-z0-9])(?![$])/;
      const IDENT_RE = regex.concat(
        /[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*/,
        NOT_PERL_ETC
      );
      const PASCAL_CASE_CLASS_NAME_RE = regex.concat(
        /(\\?[A-Z][a-z0-9_\x7f-\xff]+|\\?[A-Z]+(?=[A-Z][a-z0-9_\x7f-\xff])){1,}/,
        NOT_PERL_ETC
      );
      const UPCASE_NAME_RE = regex.concat(
        /[A-Z]+/,
        NOT_PERL_ETC
      );
      const VARIABLE = {
        scope: "variable",
        match: "\\$+" + IDENT_RE
      };
      const PREPROCESSOR = {
        scope: "meta",
        variants: [
          { begin: /<\?php/, relevance: 10 },
          // boost for obvious PHP
          { begin: /<\?=/ },
          // less relevant per PSR-1 which says not to use short-tags
          { begin: /<\?/, relevance: 0.1 },
          { begin: /\?>/ }
          // end php tag
        ]
      };
      const SUBST = {
        scope: "subst",
        variants: [
          { begin: /\$\w+/ },
          {
            begin: /\{\$/,
            end: /\}/
          }
        ]
      };
      const SINGLE_QUOTED = hljs.inherit(hljs.APOS_STRING_MODE, { illegal: null });
      const DOUBLE_QUOTED = hljs.inherit(hljs.QUOTE_STRING_MODE, {
        illegal: null,
        contains: hljs.QUOTE_STRING_MODE.contains.concat(SUBST)
      });
      const HEREDOC = {
        begin: /<<<[ \t]*(?:(\w+)|"(\w+)")\n/,
        end: /[ \t]*(\w+)\b/,
        contains: hljs.QUOTE_STRING_MODE.contains.concat(SUBST),
        "on:begin": (m6, resp) => {
          resp.data._beginMatch = m6[1] || m6[2];
        },
        "on:end": (m6, resp) => {
          if (resp.data._beginMatch !== m6[1]) resp.ignoreMatch();
        }
      };
      const NOWDOC = hljs.END_SAME_AS_BEGIN({
        begin: /<<<[ \t]*'(\w+)'\n/,
        end: /[ \t]*(\w+)\b/
      });
      const WHITESPACE = "[ 	\n]";
      const STRING = {
        scope: "string",
        variants: [
          DOUBLE_QUOTED,
          SINGLE_QUOTED,
          HEREDOC,
          NOWDOC
        ]
      };
      const NUMBER = {
        scope: "number",
        variants: [
          { begin: `\\b0[bB][01]+(?:_[01]+)*\\b` },
          // Binary w/ underscore support
          { begin: `\\b0[oO][0-7]+(?:_[0-7]+)*\\b` },
          // Octals w/ underscore support
          { begin: `\\b0[xX][\\da-fA-F]+(?:_[\\da-fA-F]+)*\\b` },
          // Hex w/ underscore support
          // Decimals w/ underscore support, with optional fragments and scientific exponent (e) suffix.
          { begin: `(?:\\b\\d+(?:_\\d+)*(\\.(?:\\d+(?:_\\d+)*))?|\\B\\.\\d+)(?:[eE][+-]?\\d+)?` }
        ],
        relevance: 0
      };
      const LITERALS = [
        "false",
        "null",
        "true"
      ];
      const KWS = [
        // Magic constants:
        // <https://www.php.net/manual/en/language.constants.predefined.php>
        "__CLASS__",
        "__DIR__",
        "__FILE__",
        "__FUNCTION__",
        "__COMPILER_HALT_OFFSET__",
        "__LINE__",
        "__METHOD__",
        "__NAMESPACE__",
        "__TRAIT__",
        // Function that look like language construct or language construct that look like function:
        // List of keywords that may not require parenthesis
        "die",
        "echo",
        "exit",
        "include",
        "include_once",
        "print",
        "require",
        "require_once",
        // These are not language construct (function) but operate on the currently-executing function and can access the current symbol table
        // 'compact extract func_get_arg func_get_args func_num_args get_called_class get_parent_class ' +
        // Other keywords:
        // <https://www.php.net/manual/en/reserved.php>
        // <https://www.php.net/manual/en/language.types.type-juggling.php>
        "array",
        "abstract",
        "and",
        "as",
        "binary",
        "bool",
        "boolean",
        "break",
        "callable",
        "case",
        "catch",
        "class",
        "clone",
        "const",
        "continue",
        "declare",
        "default",
        "do",
        "double",
        "else",
        "elseif",
        "empty",
        "enddeclare",
        "endfor",
        "endforeach",
        "endif",
        "endswitch",
        "endwhile",
        "enum",
        "eval",
        "extends",
        "final",
        "finally",
        "float",
        "for",
        "foreach",
        "from",
        "global",
        "goto",
        "if",
        "implements",
        "instanceof",
        "insteadof",
        "int",
        "integer",
        "interface",
        "isset",
        "iterable",
        "list",
        "match|0",
        "mixed",
        "new",
        "never",
        "object",
        "or",
        "private",
        "protected",
        "public",
        "readonly",
        "real",
        "return",
        "string",
        "switch",
        "throw",
        "trait",
        "try",
        "unset",
        "use",
        "var",
        "void",
        "while",
        "xor",
        "yield"
      ];
      const BUILT_INS = [
        // Standard PHP library:
        // <https://www.php.net/manual/en/book.spl.php>
        "Error|0",
        "AppendIterator",
        "ArgumentCountError",
        "ArithmeticError",
        "ArrayIterator",
        "ArrayObject",
        "AssertionError",
        "BadFunctionCallException",
        "BadMethodCallException",
        "CachingIterator",
        "CallbackFilterIterator",
        "CompileError",
        "Countable",
        "DirectoryIterator",
        "DivisionByZeroError",
        "DomainException",
        "EmptyIterator",
        "ErrorException",
        "Exception",
        "FilesystemIterator",
        "FilterIterator",
        "GlobIterator",
        "InfiniteIterator",
        "InvalidArgumentException",
        "IteratorIterator",
        "LengthException",
        "LimitIterator",
        "LogicException",
        "MultipleIterator",
        "NoRewindIterator",
        "OutOfBoundsException",
        "OutOfRangeException",
        "OuterIterator",
        "OverflowException",
        "ParentIterator",
        "ParseError",
        "RangeException",
        "RecursiveArrayIterator",
        "RecursiveCachingIterator",
        "RecursiveCallbackFilterIterator",
        "RecursiveDirectoryIterator",
        "RecursiveFilterIterator",
        "RecursiveIterator",
        "RecursiveIteratorIterator",
        "RecursiveRegexIterator",
        "RecursiveTreeIterator",
        "RegexIterator",
        "RuntimeException",
        "SeekableIterator",
        "SplDoublyLinkedList",
        "SplFileInfo",
        "SplFileObject",
        "SplFixedArray",
        "SplHeap",
        "SplMaxHeap",
        "SplMinHeap",
        "SplObjectStorage",
        "SplObserver",
        "SplPriorityQueue",
        "SplQueue",
        "SplStack",
        "SplSubject",
        "SplTempFileObject",
        "TypeError",
        "UnderflowException",
        "UnexpectedValueException",
        "UnhandledMatchError",
        // Reserved interfaces:
        // <https://www.php.net/manual/en/reserved.interfaces.php>
        "ArrayAccess",
        "BackedEnum",
        "Closure",
        "Fiber",
        "Generator",
        "Iterator",
        "IteratorAggregate",
        "Serializable",
        "Stringable",
        "Throwable",
        "Traversable",
        "UnitEnum",
        "WeakReference",
        "WeakMap",
        // Reserved classes:
        // <https://www.php.net/manual/en/reserved.classes.php>
        "Directory",
        "__PHP_Incomplete_Class",
        "parent",
        "php_user_filter",
        "self",
        "static",
        "stdClass"
      ];
      const dualCase = (items) => {
        const result = [];
        items.forEach((item) => {
          result.push(item);
          if (item.toLowerCase() === item) {
            result.push(item.toUpperCase());
          } else {
            result.push(item.toLowerCase());
          }
        });
        return result;
      };
      const KEYWORDS = {
        keyword: KWS,
        literal: dualCase(LITERALS),
        built_in: BUILT_INS
      };
      const normalizeKeywords = (items) => {
        return items.map((item) => {
          return item.replace(/\|\d+$/, "");
        });
      };
      const CONSTRUCTOR_CALL = { variants: [
        {
          match: [
            /new/,
            regex.concat(WHITESPACE, "+"),
            // to prevent built ins from being confused as the class constructor call
            regex.concat("(?!", normalizeKeywords(BUILT_INS).join("\\b|"), "\\b)"),
            PASCAL_CASE_CLASS_NAME_RE
          ],
          scope: {
            1: "keyword",
            4: "title.class"
          }
        }
      ] };
      const CONSTANT_REFERENCE = regex.concat(IDENT_RE, "\\b(?!\\()");
      const LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON = { variants: [
        {
          match: [
            regex.concat(
              /::/,
              regex.lookahead(/(?!class\b)/)
            ),
            CONSTANT_REFERENCE
          ],
          scope: { 2: "variable.constant" }
        },
        {
          match: [
            /::/,
            /class/
          ],
          scope: { 2: "variable.language" }
        },
        {
          match: [
            PASCAL_CASE_CLASS_NAME_RE,
            regex.concat(
              /::/,
              regex.lookahead(/(?!class\b)/)
            ),
            CONSTANT_REFERENCE
          ],
          scope: {
            1: "title.class",
            3: "variable.constant"
          }
        },
        {
          match: [
            PASCAL_CASE_CLASS_NAME_RE,
            regex.concat(
              "::",
              regex.lookahead(/(?!class\b)/)
            )
          ],
          scope: { 1: "title.class" }
        },
        {
          match: [
            PASCAL_CASE_CLASS_NAME_RE,
            /::/,
            /class/
          ],
          scope: {
            1: "title.class",
            3: "variable.language"
          }
        }
      ] };
      const NAMED_ARGUMENT = {
        scope: "attr",
        match: regex.concat(IDENT_RE, regex.lookahead(":"), regex.lookahead(/(?!::)/))
      };
      const PARAMS_MODE = {
        relevance: 0,
        begin: /\(/,
        end: /\)/,
        keywords: KEYWORDS,
        contains: [
          NAMED_ARGUMENT,
          VARIABLE,
          LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON,
          hljs.C_BLOCK_COMMENT_MODE,
          STRING,
          NUMBER,
          CONSTRUCTOR_CALL
        ]
      };
      const FUNCTION_INVOKE = {
        relevance: 0,
        match: [
          /\b/,
          // to prevent keywords from being confused as the function title
          regex.concat("(?!fn\\b|function\\b|", normalizeKeywords(KWS).join("\\b|"), "|", normalizeKeywords(BUILT_INS).join("\\b|"), "\\b)"),
          IDENT_RE,
          regex.concat(WHITESPACE, "*"),
          regex.lookahead(/(?=\()/)
        ],
        scope: { 3: "title.function.invoke" },
        contains: [PARAMS_MODE]
      };
      PARAMS_MODE.contains.push(FUNCTION_INVOKE);
      const ATTRIBUTE_CONTAINS = [
        NAMED_ARGUMENT,
        LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON,
        hljs.C_BLOCK_COMMENT_MODE,
        STRING,
        NUMBER,
        CONSTRUCTOR_CALL
      ];
      const ATTRIBUTES = {
        begin: regex.concat(
          /#\[\s*\\?/,
          regex.either(
            PASCAL_CASE_CLASS_NAME_RE,
            UPCASE_NAME_RE
          )
        ),
        beginScope: "meta",
        end: /]/,
        endScope: "meta",
        keywords: {
          literal: LITERALS,
          keyword: [
            "new",
            "array"
          ]
        },
        contains: [
          {
            begin: /\[/,
            end: /]/,
            keywords: {
              literal: LITERALS,
              keyword: [
                "new",
                "array"
              ]
            },
            contains: [
              "self",
              ...ATTRIBUTE_CONTAINS
            ]
          },
          ...ATTRIBUTE_CONTAINS,
          {
            scope: "meta",
            variants: [
              { match: PASCAL_CASE_CLASS_NAME_RE },
              { match: UPCASE_NAME_RE }
            ]
          }
        ]
      };
      return {
        case_insensitive: false,
        keywords: KEYWORDS,
        contains: [
          ATTRIBUTES,
          hljs.HASH_COMMENT_MODE,
          hljs.COMMENT("//", "$"),
          hljs.COMMENT(
            "/\\*",
            "\\*/",
            { contains: [
              {
                scope: "doctag",
                match: "@[A-Za-z]+"
              }
            ] }
          ),
          {
            match: /__halt_compiler\(\);/,
            keywords: "__halt_compiler",
            starts: {
              scope: "comment",
              end: hljs.MATCH_NOTHING_RE,
              contains: [
                {
                  match: /\?>/,
                  scope: "meta",
                  endsParent: true
                }
              ]
            }
          },
          PREPROCESSOR,
          {
            scope: "variable.language",
            match: /\$this\b/
          },
          VARIABLE,
          FUNCTION_INVOKE,
          LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON,
          {
            match: [
              /const/,
              /\s/,
              IDENT_RE
            ],
            scope: {
              1: "keyword",
              3: "variable.constant"
            }
          },
          CONSTRUCTOR_CALL,
          {
            scope: "function",
            relevance: 0,
            beginKeywords: "fn function",
            end: /[;{]/,
            excludeEnd: true,
            illegal: "[$%\\[]",
            contains: [
              { beginKeywords: "use" },
              hljs.UNDERSCORE_TITLE_MODE,
              {
                begin: "=>",
                // No markup, just a relevance booster
                endsParent: true
              },
              {
                scope: "params",
                begin: "\\(",
                end: "\\)",
                excludeBegin: true,
                excludeEnd: true,
                keywords: KEYWORDS,
                contains: [
                  "self",
                  ATTRIBUTES,
                  VARIABLE,
                  LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON,
                  hljs.C_BLOCK_COMMENT_MODE,
                  STRING,
                  NUMBER
                ]
              }
            ]
          },
          {
            scope: "class",
            variants: [
              {
                beginKeywords: "enum",
                illegal: /[($"]/
              },
              {
                beginKeywords: "class interface trait",
                illegal: /[:($"]/
              }
            ],
            relevance: 0,
            end: /\{/,
            excludeEnd: true,
            contains: [
              { beginKeywords: "extends implements" },
              hljs.UNDERSCORE_TITLE_MODE
            ]
          },
          // both use and namespace still use "old style" rules (vs multi-match)
          // because the namespace name can include `\` and we still want each
          // element to be treated as its own *individual* title
          {
            beginKeywords: "namespace",
            relevance: 0,
            end: ";",
            illegal: /[.']/,
            contains: [hljs.inherit(hljs.UNDERSCORE_TITLE_MODE, { scope: "title.class" })]
          },
          {
            beginKeywords: "use",
            relevance: 0,
            end: ";",
            contains: [
              // TODO: title.function vs title.class
              {
                match: /\b(as|const|function)\b/,
                scope: "keyword"
              },
              // TODO: could be title.class or title.function
              hljs.UNDERSCORE_TITLE_MODE
            ]
          },
          STRING,
          NUMBER
        ]
      };
    }
    module.exports = php;
  }
});

// node_modules/highlight.js/lib/languages/php-template.js
var require_php_template = __commonJS({
  "node_modules/highlight.js/lib/languages/php-template.js"(exports, module) {
    function phpTemplate(hljs) {
      return {
        name: "PHP template",
        subLanguage: "xml",
        contains: [
          {
            begin: /<\?(php|=)?/,
            end: /\?>/,
            subLanguage: "php",
            contains: [
              // We don't want the php closing tag ?> to close the PHP block when
              // inside any of the following blocks:
              {
                begin: "/\\*",
                end: "\\*/",
                skip: true
              },
              {
                begin: 'b"',
                end: '"',
                skip: true
              },
              {
                begin: "b'",
                end: "'",
                skip: true
              },
              hljs.inherit(hljs.APOS_STRING_MODE, {
                illegal: null,
                className: null,
                contains: null,
                skip: true
              }),
              hljs.inherit(hljs.QUOTE_STRING_MODE, {
                illegal: null,
                className: null,
                contains: null,
                skip: true
              })
            ]
          }
        ]
      };
    }
    module.exports = phpTemplate;
  }
});

// node_modules/highlight.js/lib/languages/plaintext.js
var require_plaintext = __commonJS({
  "node_modules/highlight.js/lib/languages/plaintext.js"(exports, module) {
    function plaintext(hljs) {
      return {
        name: "Plain text",
        aliases: [
          "text",
          "txt"
        ],
        disableAutodetect: true
      };
    }
    module.exports = plaintext;
  }
});

// node_modules/highlight.js/lib/languages/python.js
var require_python = __commonJS({
  "node_modules/highlight.js/lib/languages/python.js"(exports, module) {
    function python(hljs) {
      const regex = hljs.regex;
      const IDENT_RE = /[\p{XID_Start}_]\p{XID_Continue}*/u;
      const RESERVED_WORDS = [
        "and",
        "as",
        "assert",
        "async",
        "await",
        "break",
        "case",
        "class",
        "continue",
        "def",
        "del",
        "elif",
        "else",
        "except",
        "finally",
        "for",
        "from",
        "global",
        "if",
        "import",
        "in",
        "is",
        "lambda",
        "match",
        "nonlocal|10",
        "not",
        "or",
        "pass",
        "raise",
        "return",
        "try",
        "while",
        "with",
        "yield"
      ];
      const BUILT_INS = [
        "__import__",
        "abs",
        "all",
        "any",
        "ascii",
        "bin",
        "bool",
        "breakpoint",
        "bytearray",
        "bytes",
        "callable",
        "chr",
        "classmethod",
        "compile",
        "complex",
        "delattr",
        "dict",
        "dir",
        "divmod",
        "enumerate",
        "eval",
        "exec",
        "filter",
        "float",
        "format",
        "frozenset",
        "getattr",
        "globals",
        "hasattr",
        "hash",
        "help",
        "hex",
        "id",
        "input",
        "int",
        "isinstance",
        "issubclass",
        "iter",
        "len",
        "list",
        "locals",
        "map",
        "max",
        "memoryview",
        "min",
        "next",
        "object",
        "oct",
        "open",
        "ord",
        "pow",
        "print",
        "property",
        "range",
        "repr",
        "reversed",
        "round",
        "set",
        "setattr",
        "slice",
        "sorted",
        "staticmethod",
        "str",
        "sum",
        "super",
        "tuple",
        "type",
        "vars",
        "zip"
      ];
      const LITERALS = [
        "__debug__",
        "Ellipsis",
        "False",
        "None",
        "NotImplemented",
        "True"
      ];
      const TYPES = [
        "Any",
        "Callable",
        "Coroutine",
        "Dict",
        "List",
        "Literal",
        "Generic",
        "Optional",
        "Sequence",
        "Set",
        "Tuple",
        "Type",
        "Union"
      ];
      const KEYWORDS = {
        $pattern: /[A-Za-z]\w+|__\w+__/,
        keyword: RESERVED_WORDS,
        built_in: BUILT_INS,
        literal: LITERALS,
        type: TYPES
      };
      const PROMPT = {
        className: "meta",
        begin: /^(>>>|\.\.\.) /
      };
      const SUBST = {
        className: "subst",
        begin: /\{/,
        end: /\}/,
        keywords: KEYWORDS,
        illegal: /#/
      };
      const LITERAL_BRACKET = {
        begin: /\{\{/,
        relevance: 0
      };
      const STRING = {
        className: "string",
        contains: [hljs.BACKSLASH_ESCAPE],
        variants: [
          {
            begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?'''/,
            end: /'''/,
            contains: [
              hljs.BACKSLASH_ESCAPE,
              PROMPT
            ],
            relevance: 10
          },
          {
            begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?"""/,
            end: /"""/,
            contains: [
              hljs.BACKSLASH_ESCAPE,
              PROMPT
            ],
            relevance: 10
          },
          {
            begin: /([fF][rR]|[rR][fF]|[fF])'''/,
            end: /'''/,
            contains: [
              hljs.BACKSLASH_ESCAPE,
              PROMPT,
              LITERAL_BRACKET,
              SUBST
            ]
          },
          {
            begin: /([fF][rR]|[rR][fF]|[fF])"""/,
            end: /"""/,
            contains: [
              hljs.BACKSLASH_ESCAPE,
              PROMPT,
              LITERAL_BRACKET,
              SUBST
            ]
          },
          {
            begin: /([uU]|[rR])'/,
            end: /'/,
            relevance: 10
          },
          {
            begin: /([uU]|[rR])"/,
            end: /"/,
            relevance: 10
          },
          {
            begin: /([bB]|[bB][rR]|[rR][bB])'/,
            end: /'/
          },
          {
            begin: /([bB]|[bB][rR]|[rR][bB])"/,
            end: /"/
          },
          {
            begin: /([fF][rR]|[rR][fF]|[fF])'/,
            end: /'/,
            contains: [
              hljs.BACKSLASH_ESCAPE,
              LITERAL_BRACKET,
              SUBST
            ]
          },
          {
            begin: /([fF][rR]|[rR][fF]|[fF])"/,
            end: /"/,
            contains: [
              hljs.BACKSLASH_ESCAPE,
              LITERAL_BRACKET,
              SUBST
            ]
          },
          hljs.APOS_STRING_MODE,
          hljs.QUOTE_STRING_MODE
        ]
      };
      const digitpart = "[0-9](_?[0-9])*";
      const pointfloat = `(\\b(${digitpart}))?\\.(${digitpart})|\\b(${digitpart})\\.`;
      const lookahead = `\\b|${RESERVED_WORDS.join("|")}`;
      const NUMBER = {
        className: "number",
        relevance: 0,
        variants: [
          // exponentfloat, pointfloat
          // https://docs.python.org/3.9/reference/lexical_analysis.html#floating-point-literals
          // optionally imaginary
          // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
          // Note: no leading \b because floats can start with a decimal point
          // and we don't want to mishandle e.g. `fn(.5)`,
          // no trailing \b for pointfloat because it can end with a decimal point
          // and we don't want to mishandle e.g. `0..hex()`; this should be safe
          // because both MUST contain a decimal point and so cannot be confused with
          // the interior part of an identifier
          {
            begin: `(\\b(${digitpart})|(${pointfloat}))[eE][+-]?(${digitpart})[jJ]?(?=${lookahead})`
          },
          {
            begin: `(${pointfloat})[jJ]?`
          },
          // decinteger, bininteger, octinteger, hexinteger
          // https://docs.python.org/3.9/reference/lexical_analysis.html#integer-literals
          // optionally "long" in Python 2
          // https://docs.python.org/2.7/reference/lexical_analysis.html#integer-and-long-integer-literals
          // decinteger is optionally imaginary
          // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
          {
            begin: `\\b([1-9](_?[0-9])*|0+(_?0)*)[lLjJ]?(?=${lookahead})`
          },
          {
            begin: `\\b0[bB](_?[01])+[lL]?(?=${lookahead})`
          },
          {
            begin: `\\b0[oO](_?[0-7])+[lL]?(?=${lookahead})`
          },
          {
            begin: `\\b0[xX](_?[0-9a-fA-F])+[lL]?(?=${lookahead})`
          },
          // imagnumber (digitpart-based)
          // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
          {
            begin: `\\b(${digitpart})[jJ](?=${lookahead})`
          }
        ]
      };
      const COMMENT_TYPE = {
        className: "comment",
        begin: regex.lookahead(/# type:/),
        end: /$/,
        keywords: KEYWORDS,
        contains: [
          {
            // prevent keywords from coloring `type`
            begin: /# type:/
          },
          // comment within a datatype comment includes no keywords
          {
            begin: /#/,
            end: /\b\B/,
            endsWithParent: true
          }
        ]
      };
      const PARAMS = {
        className: "params",
        variants: [
          // Exclude params in functions without params
          {
            className: "",
            begin: /\(\s*\)/,
            skip: true
          },
          {
            begin: /\(/,
            end: /\)/,
            excludeBegin: true,
            excludeEnd: true,
            keywords: KEYWORDS,
            contains: [
              "self",
              PROMPT,
              NUMBER,
              STRING,
              hljs.HASH_COMMENT_MODE
            ]
          }
        ]
      };
      SUBST.contains = [
        STRING,
        NUMBER,
        PROMPT
      ];
      return {
        name: "Python",
        aliases: [
          "py",
          "gyp",
          "ipython"
        ],
        unicodeRegex: true,
        keywords: KEYWORDS,
        illegal: /(<\/|\?)|=>/,
        contains: [
          PROMPT,
          NUMBER,
          {
            // very common convention
            scope: "variable.language",
            match: /\bself\b/
          },
          {
            // eat "if" prior to string so that it won't accidentally be
            // labeled as an f-string
            beginKeywords: "if",
            relevance: 0
          },
          { match: /\bor\b/, scope: "keyword" },
          STRING,
          COMMENT_TYPE,
          hljs.HASH_COMMENT_MODE,
          {
            match: [
              /\bdef/,
              /\s+/,
              IDENT_RE
            ],
            scope: {
              1: "keyword",
              3: "title.function"
            },
            contains: [PARAMS]
          },
          {
            variants: [
              {
                match: [
                  /\bclass/,
                  /\s+/,
                  IDENT_RE,
                  /\s*/,
                  /\(\s*/,
                  IDENT_RE,
                  /\s*\)/
                ]
              },
              {
                match: [
                  /\bclass/,
                  /\s+/,
                  IDENT_RE
                ]
              }
            ],
            scope: {
              1: "keyword",
              3: "title.class",
              6: "title.class.inherited"
            }
          },
          {
            className: "meta",
            begin: /^[\t ]*@/,
            end: /(?=#)|$/,
            contains: [
              NUMBER,
              PARAMS,
              STRING
            ]
          }
        ]
      };
    }
    module.exports = python;
  }
});

// node_modules/highlight.js/lib/languages/python-repl.js
var require_python_repl = __commonJS({
  "node_modules/highlight.js/lib/languages/python-repl.js"(exports, module) {
    function pythonRepl(hljs) {
      return {
        aliases: ["pycon"],
        contains: [
          {
            className: "meta.prompt",
            starts: {
              // a space separates the REPL prefix from the actual code
              // this is purely for cleaner HTML output
              end: / |$/,
              starts: {
                end: "$",
                subLanguage: "python"
              }
            },
            variants: [
              { begin: /^>>>(?=[ ]|$)/ },
              { begin: /^\.\.\.(?=[ ]|$)/ }
            ]
          }
        ]
      };
    }
    module.exports = pythonRepl;
  }
});

// node_modules/highlight.js/lib/languages/r.js
var require_r = __commonJS({
  "node_modules/highlight.js/lib/languages/r.js"(exports, module) {
    function r4(hljs) {
      const regex = hljs.regex;
      const IDENT_RE = /(?:(?:[a-zA-Z]|\.[._a-zA-Z])[._a-zA-Z0-9]*)|\.(?!\d)/;
      const NUMBER_TYPES_RE = regex.either(
        // Special case: only hexadecimal binary powers can contain fractions
        /0[xX][0-9a-fA-F]+\.[0-9a-fA-F]*[pP][+-]?\d+i?/,
        // Hexadecimal numbers without fraction and optional binary power
        /0[xX][0-9a-fA-F]+(?:[pP][+-]?\d+)?[Li]?/,
        // Decimal numbers
        /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[Li]?/
      );
      const OPERATORS_RE = /[=!<>:]=|\|\||&&|:::?|<-|<<-|->>|->|\|>|[-+*\/?!$&|:<=>@^~]|\*\*/;
      const PUNCTUATION_RE = regex.either(
        /[()]/,
        /[{}]/,
        /\[\[/,
        /[[\]]/,
        /\\/,
        /,/
      );
      return {
        name: "R",
        keywords: {
          $pattern: IDENT_RE,
          keyword: "function if in break next repeat else for while",
          literal: "NULL NA TRUE FALSE Inf NaN NA_integer_|10 NA_real_|10 NA_character_|10 NA_complex_|10",
          built_in: (
            // Builtin constants
            "LETTERS letters month.abb month.name pi T F abs acos acosh all any anyNA Arg as.call as.character as.complex as.double as.environment as.integer as.logical as.null.default as.numeric as.raw asin asinh atan atanh attr attributes baseenv browser c call ceiling class Conj cos cosh cospi cummax cummin cumprod cumsum digamma dim dimnames emptyenv exp expression floor forceAndCall gamma gc.time globalenv Im interactive invisible is.array is.atomic is.call is.character is.complex is.double is.environment is.expression is.finite is.function is.infinite is.integer is.language is.list is.logical is.matrix is.na is.name is.nan is.null is.numeric is.object is.pairlist is.raw is.recursive is.single is.symbol lazyLoadDBfetch length lgamma list log max min missing Mod names nargs nzchar oldClass on.exit pos.to.env proc.time prod quote range Re rep retracemem return round seq_along seq_len seq.int sign signif sin sinh sinpi sqrt standardGeneric substitute sum switch tan tanh tanpi tracemem trigamma trunc unclass untracemem UseMethod xtfrm"
          )
        },
        contains: [
          // Roxygen comments
          hljs.COMMENT(
            /#'/,
            /$/,
            { contains: [
              {
                // Handle `@examples` separately to cause all subsequent code
                // until the next `@`-tag on its own line to be kept as-is,
                // preventing highlighting. This code is example R code, so nested
                // doctags shouldn’t be treated as such. See
                // `test/markup/r/roxygen.txt` for an example.
                scope: "doctag",
                match: /@examples/,
                starts: {
                  end: regex.lookahead(regex.either(
                    // end if another doc comment
                    /\n^#'\s*(?=@[a-zA-Z]+)/,
                    // or a line with no comment
                    /\n^(?!#')/
                  )),
                  endsParent: true
                }
              },
              {
                // Handle `@param` to highlight the parameter name following
                // after.
                scope: "doctag",
                begin: "@param",
                end: /$/,
                contains: [
                  {
                    scope: "variable",
                    variants: [
                      { match: IDENT_RE },
                      { match: /`(?:\\.|[^`\\])+`/ }
                    ],
                    endsParent: true
                  }
                ]
              },
              {
                scope: "doctag",
                match: /@[a-zA-Z]+/
              },
              {
                scope: "keyword",
                match: /\\[a-zA-Z]+/
              }
            ] }
          ),
          hljs.HASH_COMMENT_MODE,
          {
            scope: "string",
            contains: [hljs.BACKSLASH_ESCAPE],
            variants: [
              hljs.END_SAME_AS_BEGIN({
                begin: /[rR]"(-*)\(/,
                end: /\)(-*)"/
              }),
              hljs.END_SAME_AS_BEGIN({
                begin: /[rR]"(-*)\{/,
                end: /\}(-*)"/
              }),
              hljs.END_SAME_AS_BEGIN({
                begin: /[rR]"(-*)\[/,
                end: /\](-*)"/
              }),
              hljs.END_SAME_AS_BEGIN({
                begin: /[rR]'(-*)\(/,
                end: /\)(-*)'/
              }),
              hljs.END_SAME_AS_BEGIN({
                begin: /[rR]'(-*)\{/,
                end: /\}(-*)'/
              }),
              hljs.END_SAME_AS_BEGIN({
                begin: /[rR]'(-*)\[/,
                end: /\](-*)'/
              }),
              {
                begin: '"',
                end: '"',
                relevance: 0
              },
              {
                begin: "'",
                end: "'",
                relevance: 0
              }
            ]
          },
          // Matching numbers immediately following punctuation and operators is
          // tricky since we need to look at the character ahead of a number to
          // ensure the number is not part of an identifier, and we cannot use
          // negative look-behind assertions. So instead we explicitly handle all
          // possible combinations of (operator|punctuation), number.
          // TODO: replace with negative look-behind when available
          // { begin: /(?<![a-zA-Z0-9._])0[xX][0-9a-fA-F]+\.[0-9a-fA-F]*[pP][+-]?\d+i?/ },
          // { begin: /(?<![a-zA-Z0-9._])0[xX][0-9a-fA-F]+([pP][+-]?\d+)?[Li]?/ },
          // { begin: /(?<![a-zA-Z0-9._])(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[Li]?/ }
          {
            relevance: 0,
            variants: [
              {
                scope: {
                  1: "operator",
                  2: "number"
                },
                match: [
                  OPERATORS_RE,
                  NUMBER_TYPES_RE
                ]
              },
              {
                scope: {
                  1: "operator",
                  2: "number"
                },
                match: [
                  /%[^%]*%/,
                  NUMBER_TYPES_RE
                ]
              },
              {
                scope: {
                  1: "punctuation",
                  2: "number"
                },
                match: [
                  PUNCTUATION_RE,
                  NUMBER_TYPES_RE
                ]
              },
              {
                scope: { 2: "number" },
                match: [
                  /[^a-zA-Z0-9._]|^/,
                  // not part of an identifier, or start of document
                  NUMBER_TYPES_RE
                ]
              }
            ]
          },
          // Operators/punctuation when they're not directly followed by numbers
          {
            // Relevance boost for the most common assignment form.
            scope: { 3: "operator" },
            match: [
              IDENT_RE,
              /\s+/,
              /<-/,
              /\s+/
            ]
          },
          {
            scope: "operator",
            relevance: 0,
            variants: [
              { match: OPERATORS_RE },
              { match: /%[^%]*%/ }
            ]
          },
          {
            scope: "punctuation",
            relevance: 0,
            match: PUNCTUATION_RE
          },
          {
            // Escaped identifier
            begin: "`",
            end: "`",
            contains: [{ begin: /\\./ }]
          }
        ]
      };
    }
    module.exports = r4;
  }
});

// node_modules/highlight.js/lib/languages/rust.js
var require_rust = __commonJS({
  "node_modules/highlight.js/lib/languages/rust.js"(exports, module) {
    function rust(hljs) {
      const regex = hljs.regex;
      const RAW_IDENTIFIER = /(r#)?/;
      const UNDERSCORE_IDENT_RE = regex.concat(RAW_IDENTIFIER, hljs.UNDERSCORE_IDENT_RE);
      const IDENT_RE = regex.concat(RAW_IDENTIFIER, hljs.IDENT_RE);
      const FUNCTION_INVOKE = {
        className: "title.function.invoke",
        relevance: 0,
        begin: regex.concat(
          /\b/,
          /(?!let|for|while|if|else|match\b)/,
          IDENT_RE,
          regex.lookahead(/\s*\(/)
        )
      };
      const NUMBER_SUFFIX = "([ui](8|16|32|64|128|size)|f(32|64))?";
      const KEYWORDS = [
        "abstract",
        "as",
        "async",
        "await",
        "become",
        "box",
        "break",
        "const",
        "continue",
        "crate",
        "do",
        "dyn",
        "else",
        "enum",
        "extern",
        "false",
        "final",
        "fn",
        "for",
        "if",
        "impl",
        "in",
        "let",
        "loop",
        "macro",
        "match",
        "mod",
        "move",
        "mut",
        "override",
        "priv",
        "pub",
        "ref",
        "return",
        "self",
        "Self",
        "static",
        "struct",
        "super",
        "trait",
        "true",
        "try",
        "type",
        "typeof",
        "union",
        "unsafe",
        "unsized",
        "use",
        "virtual",
        "where",
        "while",
        "yield"
      ];
      const LITERALS = [
        "true",
        "false",
        "Some",
        "None",
        "Ok",
        "Err"
      ];
      const BUILTINS = [
        // functions
        "drop ",
        // traits
        "Copy",
        "Send",
        "Sized",
        "Sync",
        "Drop",
        "Fn",
        "FnMut",
        "FnOnce",
        "ToOwned",
        "Clone",
        "Debug",
        "PartialEq",
        "PartialOrd",
        "Eq",
        "Ord",
        "AsRef",
        "AsMut",
        "Into",
        "From",
        "Default",
        "Iterator",
        "Extend",
        "IntoIterator",
        "DoubleEndedIterator",
        "ExactSizeIterator",
        "SliceConcatExt",
        "ToString",
        // macros
        "assert!",
        "assert_eq!",
        "bitflags!",
        "bytes!",
        "cfg!",
        "col!",
        "concat!",
        "concat_idents!",
        "debug_assert!",
        "debug_assert_eq!",
        "env!",
        "eprintln!",
        "panic!",
        "file!",
        "format!",
        "format_args!",
        "include_bytes!",
        "include_str!",
        "line!",
        "local_data_key!",
        "module_path!",
        "option_env!",
        "print!",
        "println!",
        "select!",
        "stringify!",
        "try!",
        "unimplemented!",
        "unreachable!",
        "vec!",
        "write!",
        "writeln!",
        "macro_rules!",
        "assert_ne!",
        "debug_assert_ne!"
      ];
      const TYPES = [
        "i8",
        "i16",
        "i32",
        "i64",
        "i128",
        "isize",
        "u8",
        "u16",
        "u32",
        "u64",
        "u128",
        "usize",
        "f32",
        "f64",
        "str",
        "char",
        "bool",
        "Box",
        "Option",
        "Result",
        "String",
        "Vec"
      ];
      return {
        name: "Rust",
        aliases: ["rs"],
        keywords: {
          $pattern: hljs.IDENT_RE + "!?",
          type: TYPES,
          keyword: KEYWORDS,
          literal: LITERALS,
          built_in: BUILTINS
        },
        illegal: "</",
        contains: [
          hljs.C_LINE_COMMENT_MODE,
          hljs.COMMENT("/\\*", "\\*/", { contains: ["self"] }),
          hljs.inherit(hljs.QUOTE_STRING_MODE, {
            begin: /b?"/,
            illegal: null
          }),
          {
            className: "symbol",
            // negative lookahead to avoid matching `'`
            begin: /'[a-zA-Z_][a-zA-Z0-9_]*(?!')/
          },
          {
            scope: "string",
            variants: [
              { begin: /b?r(#*)"(.|\n)*?"\1(?!#)/ },
              {
                begin: /b?'/,
                end: /'/,
                contains: [
                  {
                    scope: "char.escape",
                    match: /\\('|\w|x\w{2}|u\w{4}|U\w{8})/
                  }
                ]
              }
            ]
          },
          {
            className: "number",
            variants: [
              { begin: "\\b0b([01_]+)" + NUMBER_SUFFIX },
              { begin: "\\b0o([0-7_]+)" + NUMBER_SUFFIX },
              { begin: "\\b0x([A-Fa-f0-9_]+)" + NUMBER_SUFFIX },
              { begin: "\\b(\\d[\\d_]*(\\.[0-9_]+)?([eE][+-]?[0-9_]+)?)" + NUMBER_SUFFIX }
            ],
            relevance: 0
          },
          {
            begin: [
              /fn/,
              /\s+/,
              UNDERSCORE_IDENT_RE
            ],
            className: {
              1: "keyword",
              3: "title.function"
            }
          },
          {
            className: "meta",
            begin: "#!?\\[",
            end: "\\]",
            contains: [
              {
                className: "string",
                begin: /"/,
                end: /"/,
                contains: [
                  hljs.BACKSLASH_ESCAPE
                ]
              }
            ]
          },
          {
            begin: [
              /let/,
              /\s+/,
              /(?:mut\s+)?/,
              UNDERSCORE_IDENT_RE
            ],
            className: {
              1: "keyword",
              3: "keyword",
              4: "variable"
            }
          },
          // must come before impl/for rule later
          {
            begin: [
              /for/,
              /\s+/,
              UNDERSCORE_IDENT_RE,
              /\s+/,
              /in/
            ],
            className: {
              1: "keyword",
              3: "variable",
              5: "keyword"
            }
          },
          {
            begin: [
              /type/,
              /\s+/,
              UNDERSCORE_IDENT_RE
            ],
            className: {
              1: "keyword",
              3: "title.class"
            }
          },
          {
            begin: [
              /(?:trait|enum|struct|union|impl|for)/,
              /\s+/,
              UNDERSCORE_IDENT_RE
            ],
            className: {
              1: "keyword",
              3: "title.class"
            }
          },
          {
            begin: hljs.IDENT_RE + "::",
            keywords: {
              keyword: "Self",
              built_in: BUILTINS,
              type: TYPES
            }
          },
          {
            className: "punctuation",
            begin: "->"
          },
          FUNCTION_INVOKE
        ]
      };
    }
    module.exports = rust;
  }
});

// node_modules/highlight.js/lib/languages/scss.js
var require_scss = __commonJS({
  "node_modules/highlight.js/lib/languages/scss.js"(exports, module) {
    var MODES = (hljs) => {
      return {
        IMPORTANT: {
          scope: "meta",
          begin: "!important"
        },
        BLOCK_COMMENT: hljs.C_BLOCK_COMMENT_MODE,
        HEXCOLOR: {
          scope: "number",
          begin: /#(([0-9a-fA-F]{3,4})|(([0-9a-fA-F]{2}){3,4}))\b/
        },
        FUNCTION_DISPATCH: {
          className: "built_in",
          begin: /[\w-]+(?=\()/
        },
        ATTRIBUTE_SELECTOR_MODE: {
          scope: "selector-attr",
          begin: /\[/,
          end: /\]/,
          illegal: "$",
          contains: [
            hljs.APOS_STRING_MODE,
            hljs.QUOTE_STRING_MODE
          ]
        },
        CSS_NUMBER_MODE: {
          scope: "number",
          begin: hljs.NUMBER_RE + "(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
          relevance: 0
        },
        CSS_VARIABLE: {
          className: "attr",
          begin: /--[A-Za-z_][A-Za-z0-9_-]*/
        }
      };
    };
    var HTML_TAGS = [
      "a",
      "abbr",
      "address",
      "article",
      "aside",
      "audio",
      "b",
      "blockquote",
      "body",
      "button",
      "canvas",
      "caption",
      "cite",
      "code",
      "dd",
      "del",
      "details",
      "dfn",
      "div",
      "dl",
      "dt",
      "em",
      "fieldset",
      "figcaption",
      "figure",
      "footer",
      "form",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hgroup",
      "html",
      "i",
      "iframe",
      "img",
      "input",
      "ins",
      "kbd",
      "label",
      "legend",
      "li",
      "main",
      "mark",
      "menu",
      "nav",
      "object",
      "ol",
      "optgroup",
      "option",
      "p",
      "picture",
      "q",
      "quote",
      "samp",
      "section",
      "select",
      "source",
      "span",
      "strong",
      "summary",
      "sup",
      "table",
      "tbody",
      "td",
      "textarea",
      "tfoot",
      "th",
      "thead",
      "time",
      "tr",
      "ul",
      "var",
      "video"
    ];
    var SVG_TAGS = [
      "defs",
      "g",
      "marker",
      "mask",
      "pattern",
      "svg",
      "switch",
      "symbol",
      "feBlend",
      "feColorMatrix",
      "feComponentTransfer",
      "feComposite",
      "feConvolveMatrix",
      "feDiffuseLighting",
      "feDisplacementMap",
      "feFlood",
      "feGaussianBlur",
      "feImage",
      "feMerge",
      "feMorphology",
      "feOffset",
      "feSpecularLighting",
      "feTile",
      "feTurbulence",
      "linearGradient",
      "radialGradient",
      "stop",
      "circle",
      "ellipse",
      "image",
      "line",
      "path",
      "polygon",
      "polyline",
      "rect",
      "text",
      "use",
      "textPath",
      "tspan",
      "foreignObject",
      "clipPath"
    ];
    var TAGS = [
      ...HTML_TAGS,
      ...SVG_TAGS
    ];
    var MEDIA_FEATURES = [
      "any-hover",
      "any-pointer",
      "aspect-ratio",
      "color",
      "color-gamut",
      "color-index",
      "device-aspect-ratio",
      "device-height",
      "device-width",
      "display-mode",
      "forced-colors",
      "grid",
      "height",
      "hover",
      "inverted-colors",
      "monochrome",
      "orientation",
      "overflow-block",
      "overflow-inline",
      "pointer",
      "prefers-color-scheme",
      "prefers-contrast",
      "prefers-reduced-motion",
      "prefers-reduced-transparency",
      "resolution",
      "scan",
      "scripting",
      "update",
      "width",
      // TODO: find a better solution?
      "min-width",
      "max-width",
      "min-height",
      "max-height"
    ].sort().reverse();
    var PSEUDO_CLASSES = [
      "active",
      "any-link",
      "blank",
      "checked",
      "current",
      "default",
      "defined",
      "dir",
      // dir()
      "disabled",
      "drop",
      "empty",
      "enabled",
      "first",
      "first-child",
      "first-of-type",
      "fullscreen",
      "future",
      "focus",
      "focus-visible",
      "focus-within",
      "has",
      // has()
      "host",
      // host or host()
      "host-context",
      // host-context()
      "hover",
      "indeterminate",
      "in-range",
      "invalid",
      "is",
      // is()
      "lang",
      // lang()
      "last-child",
      "last-of-type",
      "left",
      "link",
      "local-link",
      "not",
      // not()
      "nth-child",
      // nth-child()
      "nth-col",
      // nth-col()
      "nth-last-child",
      // nth-last-child()
      "nth-last-col",
      // nth-last-col()
      "nth-last-of-type",
      //nth-last-of-type()
      "nth-of-type",
      //nth-of-type()
      "only-child",
      "only-of-type",
      "optional",
      "out-of-range",
      "past",
      "placeholder-shown",
      "read-only",
      "read-write",
      "required",
      "right",
      "root",
      "scope",
      "target",
      "target-within",
      "user-invalid",
      "valid",
      "visited",
      "where"
      // where()
    ].sort().reverse();
    var PSEUDO_ELEMENTS = [
      "after",
      "backdrop",
      "before",
      "cue",
      "cue-region",
      "first-letter",
      "first-line",
      "grammar-error",
      "marker",
      "part",
      "placeholder",
      "selection",
      "slotted",
      "spelling-error"
    ].sort().reverse();
    var ATTRIBUTES = [
      "accent-color",
      "align-content",
      "align-items",
      "align-self",
      "alignment-baseline",
      "all",
      "anchor-name",
      "animation",
      "animation-composition",
      "animation-delay",
      "animation-direction",
      "animation-duration",
      "animation-fill-mode",
      "animation-iteration-count",
      "animation-name",
      "animation-play-state",
      "animation-range",
      "animation-range-end",
      "animation-range-start",
      "animation-timeline",
      "animation-timing-function",
      "appearance",
      "aspect-ratio",
      "backdrop-filter",
      "backface-visibility",
      "background",
      "background-attachment",
      "background-blend-mode",
      "background-clip",
      "background-color",
      "background-image",
      "background-origin",
      "background-position",
      "background-position-x",
      "background-position-y",
      "background-repeat",
      "background-size",
      "baseline-shift",
      "block-size",
      "border",
      "border-block",
      "border-block-color",
      "border-block-end",
      "border-block-end-color",
      "border-block-end-style",
      "border-block-end-width",
      "border-block-start",
      "border-block-start-color",
      "border-block-start-style",
      "border-block-start-width",
      "border-block-style",
      "border-block-width",
      "border-bottom",
      "border-bottom-color",
      "border-bottom-left-radius",
      "border-bottom-right-radius",
      "border-bottom-style",
      "border-bottom-width",
      "border-collapse",
      "border-color",
      "border-end-end-radius",
      "border-end-start-radius",
      "border-image",
      "border-image-outset",
      "border-image-repeat",
      "border-image-slice",
      "border-image-source",
      "border-image-width",
      "border-inline",
      "border-inline-color",
      "border-inline-end",
      "border-inline-end-color",
      "border-inline-end-style",
      "border-inline-end-width",
      "border-inline-start",
      "border-inline-start-color",
      "border-inline-start-style",
      "border-inline-start-width",
      "border-inline-style",
      "border-inline-width",
      "border-left",
      "border-left-color",
      "border-left-style",
      "border-left-width",
      "border-radius",
      "border-right",
      "border-right-color",
      "border-right-style",
      "border-right-width",
      "border-spacing",
      "border-start-end-radius",
      "border-start-start-radius",
      "border-style",
      "border-top",
      "border-top-color",
      "border-top-left-radius",
      "border-top-right-radius",
      "border-top-style",
      "border-top-width",
      "border-width",
      "bottom",
      "box-align",
      "box-decoration-break",
      "box-direction",
      "box-flex",
      "box-flex-group",
      "box-lines",
      "box-ordinal-group",
      "box-orient",
      "box-pack",
      "box-shadow",
      "box-sizing",
      "break-after",
      "break-before",
      "break-inside",
      "caption-side",
      "caret-color",
      "clear",
      "clip",
      "clip-path",
      "clip-rule",
      "color",
      "color-interpolation",
      "color-interpolation-filters",
      "color-profile",
      "color-rendering",
      "color-scheme",
      "column-count",
      "column-fill",
      "column-gap",
      "column-rule",
      "column-rule-color",
      "column-rule-style",
      "column-rule-width",
      "column-span",
      "column-width",
      "columns",
      "contain",
      "contain-intrinsic-block-size",
      "contain-intrinsic-height",
      "contain-intrinsic-inline-size",
      "contain-intrinsic-size",
      "contain-intrinsic-width",
      "container",
      "container-name",
      "container-type",
      "content",
      "content-visibility",
      "counter-increment",
      "counter-reset",
      "counter-set",
      "cue",
      "cue-after",
      "cue-before",
      "cursor",
      "cx",
      "cy",
      "direction",
      "display",
      "dominant-baseline",
      "empty-cells",
      "enable-background",
      "field-sizing",
      "fill",
      "fill-opacity",
      "fill-rule",
      "filter",
      "flex",
      "flex-basis",
      "flex-direction",
      "flex-flow",
      "flex-grow",
      "flex-shrink",
      "flex-wrap",
      "float",
      "flood-color",
      "flood-opacity",
      "flow",
      "font",
      "font-display",
      "font-family",
      "font-feature-settings",
      "font-kerning",
      "font-language-override",
      "font-optical-sizing",
      "font-palette",
      "font-size",
      "font-size-adjust",
      "font-smooth",
      "font-smoothing",
      "font-stretch",
      "font-style",
      "font-synthesis",
      "font-synthesis-position",
      "font-synthesis-small-caps",
      "font-synthesis-style",
      "font-synthesis-weight",
      "font-variant",
      "font-variant-alternates",
      "font-variant-caps",
      "font-variant-east-asian",
      "font-variant-emoji",
      "font-variant-ligatures",
      "font-variant-numeric",
      "font-variant-position",
      "font-variation-settings",
      "font-weight",
      "forced-color-adjust",
      "gap",
      "glyph-orientation-horizontal",
      "glyph-orientation-vertical",
      "grid",
      "grid-area",
      "grid-auto-columns",
      "grid-auto-flow",
      "grid-auto-rows",
      "grid-column",
      "grid-column-end",
      "grid-column-start",
      "grid-gap",
      "grid-row",
      "grid-row-end",
      "grid-row-start",
      "grid-template",
      "grid-template-areas",
      "grid-template-columns",
      "grid-template-rows",
      "hanging-punctuation",
      "height",
      "hyphenate-character",
      "hyphenate-limit-chars",
      "hyphens",
      "icon",
      "image-orientation",
      "image-rendering",
      "image-resolution",
      "ime-mode",
      "initial-letter",
      "initial-letter-align",
      "inline-size",
      "inset",
      "inset-area",
      "inset-block",
      "inset-block-end",
      "inset-block-start",
      "inset-inline",
      "inset-inline-end",
      "inset-inline-start",
      "isolation",
      "justify-content",
      "justify-items",
      "justify-self",
      "kerning",
      "left",
      "letter-spacing",
      "lighting-color",
      "line-break",
      "line-height",
      "line-height-step",
      "list-style",
      "list-style-image",
      "list-style-position",
      "list-style-type",
      "margin",
      "margin-block",
      "margin-block-end",
      "margin-block-start",
      "margin-bottom",
      "margin-inline",
      "margin-inline-end",
      "margin-inline-start",
      "margin-left",
      "margin-right",
      "margin-top",
      "margin-trim",
      "marker",
      "marker-end",
      "marker-mid",
      "marker-start",
      "marks",
      "mask",
      "mask-border",
      "mask-border-mode",
      "mask-border-outset",
      "mask-border-repeat",
      "mask-border-slice",
      "mask-border-source",
      "mask-border-width",
      "mask-clip",
      "mask-composite",
      "mask-image",
      "mask-mode",
      "mask-origin",
      "mask-position",
      "mask-repeat",
      "mask-size",
      "mask-type",
      "masonry-auto-flow",
      "math-depth",
      "math-shift",
      "math-style",
      "max-block-size",
      "max-height",
      "max-inline-size",
      "max-width",
      "min-block-size",
      "min-height",
      "min-inline-size",
      "min-width",
      "mix-blend-mode",
      "nav-down",
      "nav-index",
      "nav-left",
      "nav-right",
      "nav-up",
      "none",
      "normal",
      "object-fit",
      "object-position",
      "offset",
      "offset-anchor",
      "offset-distance",
      "offset-path",
      "offset-position",
      "offset-rotate",
      "opacity",
      "order",
      "orphans",
      "outline",
      "outline-color",
      "outline-offset",
      "outline-style",
      "outline-width",
      "overflow",
      "overflow-anchor",
      "overflow-block",
      "overflow-clip-margin",
      "overflow-inline",
      "overflow-wrap",
      "overflow-x",
      "overflow-y",
      "overlay",
      "overscroll-behavior",
      "overscroll-behavior-block",
      "overscroll-behavior-inline",
      "overscroll-behavior-x",
      "overscroll-behavior-y",
      "padding",
      "padding-block",
      "padding-block-end",
      "padding-block-start",
      "padding-bottom",
      "padding-inline",
      "padding-inline-end",
      "padding-inline-start",
      "padding-left",
      "padding-right",
      "padding-top",
      "page",
      "page-break-after",
      "page-break-before",
      "page-break-inside",
      "paint-order",
      "pause",
      "pause-after",
      "pause-before",
      "perspective",
      "perspective-origin",
      "place-content",
      "place-items",
      "place-self",
      "pointer-events",
      "position",
      "position-anchor",
      "position-visibility",
      "print-color-adjust",
      "quotes",
      "r",
      "resize",
      "rest",
      "rest-after",
      "rest-before",
      "right",
      "rotate",
      "row-gap",
      "ruby-align",
      "ruby-position",
      "scale",
      "scroll-behavior",
      "scroll-margin",
      "scroll-margin-block",
      "scroll-margin-block-end",
      "scroll-margin-block-start",
      "scroll-margin-bottom",
      "scroll-margin-inline",
      "scroll-margin-inline-end",
      "scroll-margin-inline-start",
      "scroll-margin-left",
      "scroll-margin-right",
      "scroll-margin-top",
      "scroll-padding",
      "scroll-padding-block",
      "scroll-padding-block-end",
      "scroll-padding-block-start",
      "scroll-padding-bottom",
      "scroll-padding-inline",
      "scroll-padding-inline-end",
      "scroll-padding-inline-start",
      "scroll-padding-left",
      "scroll-padding-right",
      "scroll-padding-top",
      "scroll-snap-align",
      "scroll-snap-stop",
      "scroll-snap-type",
      "scroll-timeline",
      "scroll-timeline-axis",
      "scroll-timeline-name",
      "scrollbar-color",
      "scrollbar-gutter",
      "scrollbar-width",
      "shape-image-threshold",
      "shape-margin",
      "shape-outside",
      "shape-rendering",
      "speak",
      "speak-as",
      "src",
      // @font-face
      "stop-color",
      "stop-opacity",
      "stroke",
      "stroke-dasharray",
      "stroke-dashoffset",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-miterlimit",
      "stroke-opacity",
      "stroke-width",
      "tab-size",
      "table-layout",
      "text-align",
      "text-align-all",
      "text-align-last",
      "text-anchor",
      "text-combine-upright",
      "text-decoration",
      "text-decoration-color",
      "text-decoration-line",
      "text-decoration-skip",
      "text-decoration-skip-ink",
      "text-decoration-style",
      "text-decoration-thickness",
      "text-emphasis",
      "text-emphasis-color",
      "text-emphasis-position",
      "text-emphasis-style",
      "text-indent",
      "text-justify",
      "text-orientation",
      "text-overflow",
      "text-rendering",
      "text-shadow",
      "text-size-adjust",
      "text-transform",
      "text-underline-offset",
      "text-underline-position",
      "text-wrap",
      "text-wrap-mode",
      "text-wrap-style",
      "timeline-scope",
      "top",
      "touch-action",
      "transform",
      "transform-box",
      "transform-origin",
      "transform-style",
      "transition",
      "transition-behavior",
      "transition-delay",
      "transition-duration",
      "transition-property",
      "transition-timing-function",
      "translate",
      "unicode-bidi",
      "user-modify",
      "user-select",
      "vector-effect",
      "vertical-align",
      "view-timeline",
      "view-timeline-axis",
      "view-timeline-inset",
      "view-timeline-name",
      "view-transition-name",
      "visibility",
      "voice-balance",
      "voice-duration",
      "voice-family",
      "voice-pitch",
      "voice-range",
      "voice-rate",
      "voice-stress",
      "voice-volume",
      "white-space",
      "white-space-collapse",
      "widows",
      "width",
      "will-change",
      "word-break",
      "word-spacing",
      "word-wrap",
      "writing-mode",
      "x",
      "y",
      "z-index",
      "zoom"
    ].sort().reverse();
    function scss(hljs) {
      const modes = MODES(hljs);
      const PSEUDO_ELEMENTS$1 = PSEUDO_ELEMENTS;
      const PSEUDO_CLASSES$1 = PSEUDO_CLASSES;
      const AT_IDENTIFIER = "@[a-z-]+";
      const AT_MODIFIERS = "and or not only";
      const IDENT_RE = "[a-zA-Z-][a-zA-Z0-9_-]*";
      const VARIABLE = {
        className: "variable",
        begin: "(\\$" + IDENT_RE + ")\\b",
        relevance: 0
      };
      return {
        name: "SCSS",
        case_insensitive: true,
        illegal: "[=/|']",
        contains: [
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          // to recognize keyframe 40% etc which are outside the scope of our
          // attribute value mode
          modes.CSS_NUMBER_MODE,
          {
            className: "selector-id",
            begin: "#[A-Za-z0-9_-]+",
            relevance: 0
          },
          {
            className: "selector-class",
            begin: "\\.[A-Za-z0-9_-]+",
            relevance: 0
          },
          modes.ATTRIBUTE_SELECTOR_MODE,
          {
            className: "selector-tag",
            begin: "\\b(" + TAGS.join("|") + ")\\b",
            // was there, before, but why?
            relevance: 0
          },
          {
            className: "selector-pseudo",
            begin: ":(" + PSEUDO_CLASSES$1.join("|") + ")"
          },
          {
            className: "selector-pseudo",
            begin: ":(:)?(" + PSEUDO_ELEMENTS$1.join("|") + ")"
          },
          VARIABLE,
          {
            // pseudo-selector params
            begin: /\(/,
            end: /\)/,
            contains: [modes.CSS_NUMBER_MODE]
          },
          modes.CSS_VARIABLE,
          {
            className: "attribute",
            begin: "\\b(" + ATTRIBUTES.join("|") + ")\\b"
          },
          { begin: "\\b(whitespace|wait|w-resize|visible|vertical-text|vertical-ideographic|uppercase|upper-roman|upper-alpha|underline|transparent|top|thin|thick|text|text-top|text-bottom|tb-rl|table-header-group|table-footer-group|sw-resize|super|strict|static|square|solid|small-caps|separate|se-resize|scroll|s-resize|rtl|row-resize|ridge|right|repeat|repeat-y|repeat-x|relative|progress|pointer|overline|outside|outset|oblique|nowrap|not-allowed|normal|none|nw-resize|no-repeat|no-drop|newspaper|ne-resize|n-resize|move|middle|medium|ltr|lr-tb|lowercase|lower-roman|lower-alpha|loose|list-item|line|line-through|line-edge|lighter|left|keep-all|justify|italic|inter-word|inter-ideograph|inside|inset|inline|inline-block|inherit|inactive|ideograph-space|ideograph-parenthesis|ideograph-numeric|ideograph-alpha|horizontal|hidden|help|hand|groove|fixed|ellipsis|e-resize|double|dotted|distribute|distribute-space|distribute-letter|distribute-all-lines|disc|disabled|default|decimal|dashed|crosshair|collapse|col-resize|circle|char|center|capitalize|break-word|break-all|bottom|both|bolder|bold|block|bidi-override|below|baseline|auto|always|all-scroll|absolute|table|table-cell)\\b" },
          {
            begin: /:/,
            end: /[;}{]/,
            relevance: 0,
            contains: [
              modes.BLOCK_COMMENT,
              VARIABLE,
              modes.HEXCOLOR,
              modes.CSS_NUMBER_MODE,
              hljs.QUOTE_STRING_MODE,
              hljs.APOS_STRING_MODE,
              modes.IMPORTANT,
              modes.FUNCTION_DISPATCH
            ]
          },
          // matching these here allows us to treat them more like regular CSS
          // rules so everything between the {} gets regular rule highlighting,
          // which is what we want for page and font-face
          {
            begin: "@(page|font-face)",
            keywords: {
              $pattern: AT_IDENTIFIER,
              keyword: "@page @font-face"
            }
          },
          {
            begin: "@",
            end: "[{;]",
            returnBegin: true,
            keywords: {
              $pattern: /[a-z-]+/,
              keyword: AT_MODIFIERS,
              attribute: MEDIA_FEATURES.join(" ")
            },
            contains: [
              {
                begin: AT_IDENTIFIER,
                className: "keyword"
              },
              {
                begin: /[a-z-]+(?=:)/,
                className: "attribute"
              },
              VARIABLE,
              hljs.QUOTE_STRING_MODE,
              hljs.APOS_STRING_MODE,
              modes.HEXCOLOR,
              modes.CSS_NUMBER_MODE
            ]
          },
          modes.FUNCTION_DISPATCH
        ]
      };
    }
    module.exports = scss;
  }
});

// node_modules/highlight.js/lib/languages/shell.js
var require_shell = __commonJS({
  "node_modules/highlight.js/lib/languages/shell.js"(exports, module) {
    function shell(hljs) {
      return {
        name: "Shell Session",
        aliases: [
          "console",
          "shellsession"
        ],
        contains: [
          {
            className: "meta.prompt",
            // We cannot add \s (spaces) in the regular expression otherwise it will be too broad and produce unexpected result.
            // For instance, in the following example, it would match "echo /path/to/home >" as a prompt:
            // echo /path/to/home > t.exe
            begin: /^\s{0,3}[/~\w\d[\]()@-]*[>%$#][ ]?/,
            starts: {
              end: /[^\\](?=\s*$)/,
              subLanguage: "bash"
            }
          }
        ]
      };
    }
    module.exports = shell;
  }
});

// node_modules/highlight.js/lib/languages/sql.js
var require_sql = __commonJS({
  "node_modules/highlight.js/lib/languages/sql.js"(exports, module) {
    function sql(hljs) {
      const regex = hljs.regex;
      const COMMENT_MODE = hljs.COMMENT("--", "$");
      const STRING = {
        scope: "string",
        variants: [
          {
            begin: /'/,
            end: /'/,
            contains: [{ match: /''/ }]
          }
        ]
      };
      const QUOTED_IDENTIFIER = {
        begin: /"/,
        end: /"/,
        contains: [{ match: /""/ }]
      };
      const LITERALS = [
        "true",
        "false",
        // Not sure it's correct to call NULL literal, and clauses like IS [NOT] NULL look strange that way.
        // "null",
        "unknown"
      ];
      const MULTI_WORD_TYPES = [
        "double precision",
        "large object",
        "with timezone",
        "without timezone"
      ];
      const TYPES = [
        "bigint",
        "binary",
        "blob",
        "boolean",
        "char",
        "character",
        "clob",
        "date",
        "dec",
        "decfloat",
        "decimal",
        "float",
        "int",
        "integer",
        "interval",
        "nchar",
        "nclob",
        "national",
        "numeric",
        "real",
        "row",
        "smallint",
        "time",
        "timestamp",
        "varchar",
        "varying",
        // modifier (character varying)
        "varbinary"
      ];
      const NON_RESERVED_WORDS = [
        "add",
        "asc",
        "collation",
        "desc",
        "final",
        "first",
        "last",
        "view"
      ];
      const RESERVED_WORDS = [
        "abs",
        "acos",
        "all",
        "allocate",
        "alter",
        "and",
        "any",
        "are",
        "array",
        "array_agg",
        "array_max_cardinality",
        "as",
        "asensitive",
        "asin",
        "asymmetric",
        "at",
        "atan",
        "atomic",
        "authorization",
        "avg",
        "begin",
        "begin_frame",
        "begin_partition",
        "between",
        "bigint",
        "binary",
        "blob",
        "boolean",
        "both",
        "by",
        "call",
        "called",
        "cardinality",
        "cascaded",
        "case",
        "cast",
        "ceil",
        "ceiling",
        "char",
        "char_length",
        "character",
        "character_length",
        "check",
        "classifier",
        "clob",
        "close",
        "coalesce",
        "collate",
        "collect",
        "column",
        "commit",
        "condition",
        "connect",
        "constraint",
        "contains",
        "convert",
        "copy",
        "corr",
        "corresponding",
        "cos",
        "cosh",
        "count",
        "covar_pop",
        "covar_samp",
        "create",
        "cross",
        "cube",
        "cume_dist",
        "current",
        "current_catalog",
        "current_date",
        "current_default_transform_group",
        "current_path",
        "current_role",
        "current_row",
        "current_schema",
        "current_time",
        "current_timestamp",
        "current_path",
        "current_role",
        "current_transform_group_for_type",
        "current_user",
        "cursor",
        "cycle",
        "date",
        "day",
        "deallocate",
        "dec",
        "decimal",
        "decfloat",
        "declare",
        "default",
        "define",
        "delete",
        "dense_rank",
        "deref",
        "describe",
        "deterministic",
        "disconnect",
        "distinct",
        "double",
        "drop",
        "dynamic",
        "each",
        "element",
        "else",
        "empty",
        "end",
        "end_frame",
        "end_partition",
        "end-exec",
        "equals",
        "escape",
        "every",
        "except",
        "exec",
        "execute",
        "exists",
        "exp",
        "external",
        "extract",
        "false",
        "fetch",
        "filter",
        "first_value",
        "float",
        "floor",
        "for",
        "foreign",
        "frame_row",
        "free",
        "from",
        "full",
        "function",
        "fusion",
        "get",
        "global",
        "grant",
        "group",
        "grouping",
        "groups",
        "having",
        "hold",
        "hour",
        "identity",
        "in",
        "indicator",
        "initial",
        "inner",
        "inout",
        "insensitive",
        "insert",
        "int",
        "integer",
        "intersect",
        "intersection",
        "interval",
        "into",
        "is",
        "join",
        "json_array",
        "json_arrayagg",
        "json_exists",
        "json_object",
        "json_objectagg",
        "json_query",
        "json_table",
        "json_table_primitive",
        "json_value",
        "lag",
        "language",
        "large",
        "last_value",
        "lateral",
        "lead",
        "leading",
        "left",
        "like",
        "like_regex",
        "listagg",
        "ln",
        "local",
        "localtime",
        "localtimestamp",
        "log",
        "log10",
        "lower",
        "match",
        "match_number",
        "match_recognize",
        "matches",
        "max",
        "member",
        "merge",
        "method",
        "min",
        "minute",
        "mod",
        "modifies",
        "module",
        "month",
        "multiset",
        "national",
        "natural",
        "nchar",
        "nclob",
        "new",
        "no",
        "none",
        "normalize",
        "not",
        "nth_value",
        "ntile",
        "null",
        "nullif",
        "numeric",
        "octet_length",
        "occurrences_regex",
        "of",
        "offset",
        "old",
        "omit",
        "on",
        "one",
        "only",
        "open",
        "or",
        "order",
        "out",
        "outer",
        "over",
        "overlaps",
        "overlay",
        "parameter",
        "partition",
        "pattern",
        "per",
        "percent",
        "percent_rank",
        "percentile_cont",
        "percentile_disc",
        "period",
        "portion",
        "position",
        "position_regex",
        "power",
        "precedes",
        "precision",
        "prepare",
        "primary",
        "procedure",
        "ptf",
        "range",
        "rank",
        "reads",
        "real",
        "recursive",
        "ref",
        "references",
        "referencing",
        "regr_avgx",
        "regr_avgy",
        "regr_count",
        "regr_intercept",
        "regr_r2",
        "regr_slope",
        "regr_sxx",
        "regr_sxy",
        "regr_syy",
        "release",
        "result",
        "return",
        "returns",
        "revoke",
        "right",
        "rollback",
        "rollup",
        "row",
        "row_number",
        "rows",
        "running",
        "savepoint",
        "scope",
        "scroll",
        "search",
        "second",
        "seek",
        "select",
        "sensitive",
        "session_user",
        "set",
        "show",
        "similar",
        "sin",
        "sinh",
        "skip",
        "smallint",
        "some",
        "specific",
        "specifictype",
        "sql",
        "sqlexception",
        "sqlstate",
        "sqlwarning",
        "sqrt",
        "start",
        "static",
        "stddev_pop",
        "stddev_samp",
        "submultiset",
        "subset",
        "substring",
        "substring_regex",
        "succeeds",
        "sum",
        "symmetric",
        "system",
        "system_time",
        "system_user",
        "table",
        "tablesample",
        "tan",
        "tanh",
        "then",
        "time",
        "timestamp",
        "timezone_hour",
        "timezone_minute",
        "to",
        "trailing",
        "translate",
        "translate_regex",
        "translation",
        "treat",
        "trigger",
        "trim",
        "trim_array",
        "true",
        "truncate",
        "uescape",
        "union",
        "unique",
        "unknown",
        "unnest",
        "update",
        "upper",
        "user",
        "using",
        "value",
        "values",
        "value_of",
        "var_pop",
        "var_samp",
        "varbinary",
        "varchar",
        "varying",
        "versioning",
        "when",
        "whenever",
        "where",
        "width_bucket",
        "window",
        "with",
        "within",
        "without",
        "year"
      ];
      const RESERVED_FUNCTIONS = [
        "abs",
        "acos",
        "array_agg",
        "asin",
        "atan",
        "avg",
        "cast",
        "ceil",
        "ceiling",
        "coalesce",
        "corr",
        "cos",
        "cosh",
        "count",
        "covar_pop",
        "covar_samp",
        "cume_dist",
        "dense_rank",
        "deref",
        "element",
        "exp",
        "extract",
        "first_value",
        "floor",
        "json_array",
        "json_arrayagg",
        "json_exists",
        "json_object",
        "json_objectagg",
        "json_query",
        "json_table",
        "json_table_primitive",
        "json_value",
        "lag",
        "last_value",
        "lead",
        "listagg",
        "ln",
        "log",
        "log10",
        "lower",
        "max",
        "min",
        "mod",
        "nth_value",
        "ntile",
        "nullif",
        "percent_rank",
        "percentile_cont",
        "percentile_disc",
        "position",
        "position_regex",
        "power",
        "rank",
        "regr_avgx",
        "regr_avgy",
        "regr_count",
        "regr_intercept",
        "regr_r2",
        "regr_slope",
        "regr_sxx",
        "regr_sxy",
        "regr_syy",
        "row_number",
        "sin",
        "sinh",
        "sqrt",
        "stddev_pop",
        "stddev_samp",
        "substring",
        "substring_regex",
        "sum",
        "tan",
        "tanh",
        "translate",
        "translate_regex",
        "treat",
        "trim",
        "trim_array",
        "unnest",
        "upper",
        "value_of",
        "var_pop",
        "var_samp",
        "width_bucket"
      ];
      const POSSIBLE_WITHOUT_PARENS = [
        "current_catalog",
        "current_date",
        "current_default_transform_group",
        "current_path",
        "current_role",
        "current_schema",
        "current_transform_group_for_type",
        "current_user",
        "session_user",
        "system_time",
        "system_user",
        "current_time",
        "localtime",
        "current_timestamp",
        "localtimestamp"
      ];
      const COMBOS = [
        "create table",
        "insert into",
        "primary key",
        "foreign key",
        "not null",
        "alter table",
        "add constraint",
        "grouping sets",
        "on overflow",
        "character set",
        "respect nulls",
        "ignore nulls",
        "nulls first",
        "nulls last",
        "depth first",
        "breadth first"
      ];
      const FUNCTIONS = RESERVED_FUNCTIONS;
      const KEYWORDS = [
        ...RESERVED_WORDS,
        ...NON_RESERVED_WORDS
      ].filter((keyword) => {
        return !RESERVED_FUNCTIONS.includes(keyword);
      });
      const VARIABLE = {
        scope: "variable",
        match: /@[a-z0-9][a-z0-9_]*/
      };
      const OPERATOR = {
        scope: "operator",
        match: /[-+*/=%^~]|&&?|\|\|?|!=?|<(?:=>?|<|>)?|>[>=]?/,
        relevance: 0
      };
      const FUNCTION_CALL = {
        match: regex.concat(/\b/, regex.either(...FUNCTIONS), /\s*\(/),
        relevance: 0,
        keywords: { built_in: FUNCTIONS }
      };
      function kws_to_regex(list) {
        return regex.concat(
          /\b/,
          regex.either(...list.map((kw) => {
            return kw.replace(/\s+/, "\\s+");
          })),
          /\b/
        );
      }
      const MULTI_WORD_KEYWORDS = {
        scope: "keyword",
        match: kws_to_regex(COMBOS),
        relevance: 0
      };
      function reduceRelevancy(list, {
        exceptions,
        when
      } = {}) {
        const qualifyFn = when;
        exceptions = exceptions || [];
        return list.map((item) => {
          if (item.match(/\|\d+$/) || exceptions.includes(item)) {
            return item;
          } else if (qualifyFn(item)) {
            return `${item}|0`;
          } else {
            return item;
          }
        });
      }
      return {
        name: "SQL",
        case_insensitive: true,
        // does not include {} or HTML tags `</`
        illegal: /[{}]|<\//,
        keywords: {
          $pattern: /\b[\w\.]+/,
          keyword: reduceRelevancy(KEYWORDS, { when: (x6) => x6.length < 3 }),
          literal: LITERALS,
          type: TYPES,
          built_in: POSSIBLE_WITHOUT_PARENS
        },
        contains: [
          {
            scope: "type",
            match: kws_to_regex(MULTI_WORD_TYPES)
          },
          MULTI_WORD_KEYWORDS,
          FUNCTION_CALL,
          VARIABLE,
          STRING,
          QUOTED_IDENTIFIER,
          hljs.C_NUMBER_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          COMMENT_MODE,
          OPERATOR
        ]
      };
    }
    module.exports = sql;
  }
});

// node_modules/highlight.js/lib/languages/swift.js
var require_swift = __commonJS({
  "node_modules/highlight.js/lib/languages/swift.js"(exports, module) {
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function concat(...args) {
      const joined = args.map((x6) => source(x6)).join("");
      return joined;
    }
    function stripOptionsFromArgs(args) {
      const opts = args[args.length - 1];
      if (typeof opts === "object" && opts.constructor === Object) {
        args.splice(args.length - 1, 1);
        return opts;
      } else {
        return {};
      }
    }
    function either(...args) {
      const opts = stripOptionsFromArgs(args);
      const joined = "(" + (opts.capture ? "" : "?:") + args.map((x6) => source(x6)).join("|") + ")";
      return joined;
    }
    var keywordWrapper = (keyword) => concat(
      /\b/,
      keyword,
      /\w$/.test(keyword) ? /\b/ : /\B/
    );
    var dotKeywords = [
      "Protocol",
      // contextual
      "Type"
      // contextual
    ].map(keywordWrapper);
    var optionalDotKeywords = [
      "init",
      "self"
    ].map(keywordWrapper);
    var keywordTypes = [
      "Any",
      "Self"
    ];
    var keywords = [
      // strings below will be fed into the regular `keywords` engine while regex
      // will result in additional modes being created to scan for those keywords to
      // avoid conflicts with other rules
      "actor",
      "any",
      // contextual
      "associatedtype",
      "async",
      "await",
      /as\?/,
      // operator
      /as!/,
      // operator
      "as",
      // operator
      "borrowing",
      // contextual
      "break",
      "case",
      "catch",
      "class",
      "consume",
      // contextual
      "consuming",
      // contextual
      "continue",
      "convenience",
      // contextual
      "copy",
      // contextual
      "default",
      "defer",
      "deinit",
      "didSet",
      // contextual
      "distributed",
      "do",
      "dynamic",
      // contextual
      "each",
      "else",
      "enum",
      "extension",
      "fallthrough",
      /fileprivate\(set\)/,
      "fileprivate",
      "final",
      // contextual
      "for",
      "func",
      "get",
      // contextual
      "guard",
      "if",
      "import",
      "indirect",
      // contextual
      "infix",
      // contextual
      /init\?/,
      /init!/,
      "inout",
      /internal\(set\)/,
      "internal",
      "in",
      "is",
      // operator
      "isolated",
      // contextual
      "nonisolated",
      // contextual
      "lazy",
      // contextual
      "let",
      "macro",
      "mutating",
      // contextual
      "nonmutating",
      // contextual
      /open\(set\)/,
      // contextual
      "open",
      // contextual
      "operator",
      "optional",
      // contextual
      "override",
      // contextual
      "package",
      "postfix",
      // contextual
      "precedencegroup",
      "prefix",
      // contextual
      /private\(set\)/,
      "private",
      "protocol",
      /public\(set\)/,
      "public",
      "repeat",
      "required",
      // contextual
      "rethrows",
      "return",
      "set",
      // contextual
      "some",
      // contextual
      "static",
      "struct",
      "subscript",
      "super",
      "switch",
      "throws",
      "throw",
      /try\?/,
      // operator
      /try!/,
      // operator
      "try",
      // operator
      "typealias",
      /unowned\(safe\)/,
      // contextual
      /unowned\(unsafe\)/,
      // contextual
      "unowned",
      // contextual
      "var",
      "weak",
      // contextual
      "where",
      "while",
      "willSet"
      // contextual
    ];
    var literals = [
      "false",
      "nil",
      "true"
    ];
    var precedencegroupKeywords = [
      "assignment",
      "associativity",
      "higherThan",
      "left",
      "lowerThan",
      "none",
      "right"
    ];
    var numberSignKeywords = [
      "#colorLiteral",
      "#column",
      "#dsohandle",
      "#else",
      "#elseif",
      "#endif",
      "#error",
      "#file",
      "#fileID",
      "#fileLiteral",
      "#filePath",
      "#function",
      "#if",
      "#imageLiteral",
      "#keyPath",
      "#line",
      "#selector",
      "#sourceLocation",
      "#warning"
    ];
    var builtIns = [
      "abs",
      "all",
      "any",
      "assert",
      "assertionFailure",
      "debugPrint",
      "dump",
      "fatalError",
      "getVaList",
      "isKnownUniquelyReferenced",
      "max",
      "min",
      "numericCast",
      "pointwiseMax",
      "pointwiseMin",
      "precondition",
      "preconditionFailure",
      "print",
      "readLine",
      "repeatElement",
      "sequence",
      "stride",
      "swap",
      "swift_unboxFromSwiftValueWithType",
      "transcode",
      "type",
      "unsafeBitCast",
      "unsafeDowncast",
      "withExtendedLifetime",
      "withUnsafeMutablePointer",
      "withUnsafePointer",
      "withVaList",
      "withoutActuallyEscaping",
      "zip"
    ];
    var operatorHead = either(
      /[/=\-+!*%<>&|^~?]/,
      /[\u00A1-\u00A7]/,
      /[\u00A9\u00AB]/,
      /[\u00AC\u00AE]/,
      /[\u00B0\u00B1]/,
      /[\u00B6\u00BB\u00BF\u00D7\u00F7]/,
      /[\u2016-\u2017]/,
      /[\u2020-\u2027]/,
      /[\u2030-\u203E]/,
      /[\u2041-\u2053]/,
      /[\u2055-\u205E]/,
      /[\u2190-\u23FF]/,
      /[\u2500-\u2775]/,
      /[\u2794-\u2BFF]/,
      /[\u2E00-\u2E7F]/,
      /[\u3001-\u3003]/,
      /[\u3008-\u3020]/,
      /[\u3030]/
    );
    var operatorCharacter = either(
      operatorHead,
      /[\u0300-\u036F]/,
      /[\u1DC0-\u1DFF]/,
      /[\u20D0-\u20FF]/,
      /[\uFE00-\uFE0F]/,
      /[\uFE20-\uFE2F]/
      // TODO: The following characters are also allowed, but the regex isn't supported yet.
      // /[\u{E0100}-\u{E01EF}]/u
    );
    var operator = concat(operatorHead, operatorCharacter, "*");
    var identifierHead = either(
      /[a-zA-Z_]/,
      /[\u00A8\u00AA\u00AD\u00AF\u00B2-\u00B5\u00B7-\u00BA]/,
      /[\u00BC-\u00BE\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/,
      /[\u0100-\u02FF\u0370-\u167F\u1681-\u180D\u180F-\u1DBF]/,
      /[\u1E00-\u1FFF]/,
      /[\u200B-\u200D\u202A-\u202E\u203F-\u2040\u2054\u2060-\u206F]/,
      /[\u2070-\u20CF\u2100-\u218F\u2460-\u24FF\u2776-\u2793]/,
      /[\u2C00-\u2DFF\u2E80-\u2FFF]/,
      /[\u3004-\u3007\u3021-\u302F\u3031-\u303F\u3040-\uD7FF]/,
      /[\uF900-\uFD3D\uFD40-\uFDCF\uFDF0-\uFE1F\uFE30-\uFE44]/,
      /[\uFE47-\uFEFE\uFF00-\uFFFD]/
      // Should be /[\uFE47-\uFFFD]/, but we have to exclude FEFF.
      // The following characters are also allowed, but the regexes aren't supported yet.
      // /[\u{10000}-\u{1FFFD}\u{20000-\u{2FFFD}\u{30000}-\u{3FFFD}\u{40000}-\u{4FFFD}]/u,
      // /[\u{50000}-\u{5FFFD}\u{60000-\u{6FFFD}\u{70000}-\u{7FFFD}\u{80000}-\u{8FFFD}]/u,
      // /[\u{90000}-\u{9FFFD}\u{A0000-\u{AFFFD}\u{B0000}-\u{BFFFD}\u{C0000}-\u{CFFFD}]/u,
      // /[\u{D0000}-\u{DFFFD}\u{E0000-\u{EFFFD}]/u
    );
    var identifierCharacter = either(
      identifierHead,
      /\d/,
      /[\u0300-\u036F\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/
    );
    var identifier = concat(identifierHead, identifierCharacter, "*");
    var typeIdentifier = concat(/[A-Z]/, identifierCharacter, "*");
    var keywordAttributes = [
      "attached",
      "autoclosure",
      concat(/convention\(/, either("swift", "block", "c"), /\)/),
      "discardableResult",
      "dynamicCallable",
      "dynamicMemberLookup",
      "escaping",
      "freestanding",
      "frozen",
      "GKInspectable",
      "IBAction",
      "IBDesignable",
      "IBInspectable",
      "IBOutlet",
      "IBSegueAction",
      "inlinable",
      "main",
      "nonobjc",
      "NSApplicationMain",
      "NSCopying",
      "NSManaged",
      concat(/objc\(/, identifier, /\)/),
      "objc",
      "objcMembers",
      "propertyWrapper",
      "requires_stored_property_inits",
      "resultBuilder",
      "Sendable",
      "testable",
      "UIApplicationMain",
      "unchecked",
      "unknown",
      "usableFromInline",
      "warn_unqualified_access"
    ];
    var availabilityKeywords = [
      "iOS",
      "iOSApplicationExtension",
      "macOS",
      "macOSApplicationExtension",
      "macCatalyst",
      "macCatalystApplicationExtension",
      "watchOS",
      "watchOSApplicationExtension",
      "tvOS",
      "tvOSApplicationExtension",
      "swift"
    ];
    function swift(hljs) {
      const WHITESPACE = {
        match: /\s+/,
        relevance: 0
      };
      const BLOCK_COMMENT = hljs.COMMENT(
        "/\\*",
        "\\*/",
        { contains: ["self"] }
      );
      const COMMENTS = [
        hljs.C_LINE_COMMENT_MODE,
        BLOCK_COMMENT
      ];
      const DOT_KEYWORD = {
        match: [
          /\./,
          either(...dotKeywords, ...optionalDotKeywords)
        ],
        className: { 2: "keyword" }
      };
      const KEYWORD_GUARD = {
        // Consume .keyword to prevent highlighting properties and methods as keywords.
        match: concat(/\./, either(...keywords)),
        relevance: 0
      };
      const PLAIN_KEYWORDS = keywords.filter((kw) => typeof kw === "string").concat(["_|0"]);
      const REGEX_KEYWORDS = keywords.filter((kw) => typeof kw !== "string").concat(keywordTypes).map(keywordWrapper);
      const KEYWORD = { variants: [
        {
          className: "keyword",
          match: either(...REGEX_KEYWORDS, ...optionalDotKeywords)
        }
      ] };
      const KEYWORDS = {
        $pattern: either(
          /\b\w+/,
          // regular keywords
          /#\w+/
          // number keywords
        ),
        keyword: PLAIN_KEYWORDS.concat(numberSignKeywords),
        literal: literals
      };
      const KEYWORD_MODES = [
        DOT_KEYWORD,
        KEYWORD_GUARD,
        KEYWORD
      ];
      const BUILT_IN_GUARD = {
        // Consume .built_in to prevent highlighting properties and methods.
        match: concat(/\./, either(...builtIns)),
        relevance: 0
      };
      const BUILT_IN = {
        className: "built_in",
        match: concat(/\b/, either(...builtIns), /(?=\()/)
      };
      const BUILT_INS = [
        BUILT_IN_GUARD,
        BUILT_IN
      ];
      const OPERATOR_GUARD = {
        // Prevent -> from being highlighting as an operator.
        match: /->/,
        relevance: 0
      };
      const OPERATOR = {
        className: "operator",
        relevance: 0,
        variants: [
          { match: operator },
          {
            // dot-operator: only operators that start with a dot are allowed to use dots as
            // characters (..., ...<, .*, etc). So there rule here is: a dot followed by one or more
            // characters that may also include dots.
            match: `\\.(\\.|${operatorCharacter})+`
          }
        ]
      };
      const OPERATORS = [
        OPERATOR_GUARD,
        OPERATOR
      ];
      const decimalDigits = "([0-9]_*)+";
      const hexDigits = "([0-9a-fA-F]_*)+";
      const NUMBER = {
        className: "number",
        relevance: 0,
        variants: [
          // decimal floating-point-literal (subsumes decimal-literal)
          { match: `\\b(${decimalDigits})(\\.(${decimalDigits}))?([eE][+-]?(${decimalDigits}))?\\b` },
          // hexadecimal floating-point-literal (subsumes hexadecimal-literal)
          { match: `\\b0x(${hexDigits})(\\.(${hexDigits}))?([pP][+-]?(${decimalDigits}))?\\b` },
          // octal-literal
          { match: /\b0o([0-7]_*)+\b/ },
          // binary-literal
          { match: /\b0b([01]_*)+\b/ }
        ]
      };
      const ESCAPED_CHARACTER = (rawDelimiter = "") => ({
        className: "subst",
        variants: [
          { match: concat(/\\/, rawDelimiter, /[0\\tnr"']/) },
          { match: concat(/\\/, rawDelimiter, /u\{[0-9a-fA-F]{1,8}\}/) }
        ]
      });
      const ESCAPED_NEWLINE = (rawDelimiter = "") => ({
        className: "subst",
        match: concat(/\\/, rawDelimiter, /[\t ]*(?:[\r\n]|\r\n)/)
      });
      const INTERPOLATION = (rawDelimiter = "") => ({
        className: "subst",
        label: "interpol",
        begin: concat(/\\/, rawDelimiter, /\(/),
        end: /\)/
      });
      const MULTILINE_STRING = (rawDelimiter = "") => ({
        begin: concat(rawDelimiter, /"""/),
        end: concat(/"""/, rawDelimiter),
        contains: [
          ESCAPED_CHARACTER(rawDelimiter),
          ESCAPED_NEWLINE(rawDelimiter),
          INTERPOLATION(rawDelimiter)
        ]
      });
      const SINGLE_LINE_STRING = (rawDelimiter = "") => ({
        begin: concat(rawDelimiter, /"/),
        end: concat(/"/, rawDelimiter),
        contains: [
          ESCAPED_CHARACTER(rawDelimiter),
          INTERPOLATION(rawDelimiter)
        ]
      });
      const STRING = {
        className: "string",
        variants: [
          MULTILINE_STRING(),
          MULTILINE_STRING("#"),
          MULTILINE_STRING("##"),
          MULTILINE_STRING("###"),
          SINGLE_LINE_STRING(),
          SINGLE_LINE_STRING("#"),
          SINGLE_LINE_STRING("##"),
          SINGLE_LINE_STRING("###")
        ]
      };
      const REGEXP_CONTENTS = [
        hljs.BACKSLASH_ESCAPE,
        {
          begin: /\[/,
          end: /\]/,
          relevance: 0,
          contains: [hljs.BACKSLASH_ESCAPE]
        }
      ];
      const BARE_REGEXP_LITERAL = {
        begin: /\/[^\s](?=[^/\n]*\/)/,
        end: /\//,
        contains: REGEXP_CONTENTS
      };
      const EXTENDED_REGEXP_LITERAL = (rawDelimiter) => {
        const begin = concat(rawDelimiter, /\//);
        const end = concat(/\//, rawDelimiter);
        return {
          begin,
          end,
          contains: [
            ...REGEXP_CONTENTS,
            {
              scope: "comment",
              begin: `#(?!.*${end})`,
              end: /$/
            }
          ]
        };
      };
      const REGEXP = {
        scope: "regexp",
        variants: [
          EXTENDED_REGEXP_LITERAL("###"),
          EXTENDED_REGEXP_LITERAL("##"),
          EXTENDED_REGEXP_LITERAL("#"),
          BARE_REGEXP_LITERAL
        ]
      };
      const QUOTED_IDENTIFIER = { match: concat(/`/, identifier, /`/) };
      const IMPLICIT_PARAMETER = {
        className: "variable",
        match: /\$\d+/
      };
      const PROPERTY_WRAPPER_PROJECTION = {
        className: "variable",
        match: `\\$${identifierCharacter}+`
      };
      const IDENTIFIERS = [
        QUOTED_IDENTIFIER,
        IMPLICIT_PARAMETER,
        PROPERTY_WRAPPER_PROJECTION
      ];
      const AVAILABLE_ATTRIBUTE = {
        match: /(@|#(un)?)available/,
        scope: "keyword",
        starts: { contains: [
          {
            begin: /\(/,
            end: /\)/,
            keywords: availabilityKeywords,
            contains: [
              ...OPERATORS,
              NUMBER,
              STRING
            ]
          }
        ] }
      };
      const KEYWORD_ATTRIBUTE = {
        scope: "keyword",
        match: concat(/@/, either(...keywordAttributes), lookahead(either(/\(/, /\s+/)))
      };
      const USER_DEFINED_ATTRIBUTE = {
        scope: "meta",
        match: concat(/@/, identifier)
      };
      const ATTRIBUTES = [
        AVAILABLE_ATTRIBUTE,
        KEYWORD_ATTRIBUTE,
        USER_DEFINED_ATTRIBUTE
      ];
      const TYPE = {
        match: lookahead(/\b[A-Z]/),
        relevance: 0,
        contains: [
          {
            // Common Apple frameworks, for relevance boost
            className: "type",
            match: concat(/(AV|CA|CF|CG|CI|CL|CM|CN|CT|MK|MP|MTK|MTL|NS|SCN|SK|UI|WK|XC)/, identifierCharacter, "+")
          },
          {
            // Type identifier
            className: "type",
            match: typeIdentifier,
            relevance: 0
          },
          {
            // Optional type
            match: /[?!]+/,
            relevance: 0
          },
          {
            // Variadic parameter
            match: /\.\.\./,
            relevance: 0
          },
          {
            // Protocol composition
            match: concat(/\s+&\s+/, lookahead(typeIdentifier)),
            relevance: 0
          }
        ]
      };
      const GENERIC_ARGUMENTS = {
        begin: /</,
        end: />/,
        keywords: KEYWORDS,
        contains: [
          ...COMMENTS,
          ...KEYWORD_MODES,
          ...ATTRIBUTES,
          OPERATOR_GUARD,
          TYPE
        ]
      };
      TYPE.contains.push(GENERIC_ARGUMENTS);
      const TUPLE_ELEMENT_NAME = {
        match: concat(identifier, /\s*:/),
        keywords: "_|0",
        relevance: 0
      };
      const TUPLE = {
        begin: /\(/,
        end: /\)/,
        relevance: 0,
        keywords: KEYWORDS,
        contains: [
          "self",
          TUPLE_ELEMENT_NAME,
          ...COMMENTS,
          REGEXP,
          ...KEYWORD_MODES,
          ...BUILT_INS,
          ...OPERATORS,
          NUMBER,
          STRING,
          ...IDENTIFIERS,
          ...ATTRIBUTES,
          TYPE
        ]
      };
      const GENERIC_PARAMETERS = {
        begin: /</,
        end: />/,
        keywords: "repeat each",
        contains: [
          ...COMMENTS,
          TYPE
        ]
      };
      const FUNCTION_PARAMETER_NAME = {
        begin: either(
          lookahead(concat(identifier, /\s*:/)),
          lookahead(concat(identifier, /\s+/, identifier, /\s*:/))
        ),
        end: /:/,
        relevance: 0,
        contains: [
          {
            className: "keyword",
            match: /\b_\b/
          },
          {
            className: "params",
            match: identifier
          }
        ]
      };
      const FUNCTION_PARAMETERS = {
        begin: /\(/,
        end: /\)/,
        keywords: KEYWORDS,
        contains: [
          FUNCTION_PARAMETER_NAME,
          ...COMMENTS,
          ...KEYWORD_MODES,
          ...OPERATORS,
          NUMBER,
          STRING,
          ...ATTRIBUTES,
          TYPE,
          TUPLE
        ],
        endsParent: true,
        illegal: /["']/
      };
      const FUNCTION_OR_MACRO = {
        match: [
          /(func|macro)/,
          /\s+/,
          either(QUOTED_IDENTIFIER.match, identifier, operator)
        ],
        className: {
          1: "keyword",
          3: "title.function"
        },
        contains: [
          GENERIC_PARAMETERS,
          FUNCTION_PARAMETERS,
          WHITESPACE
        ],
        illegal: [
          /\[/,
          /%/
        ]
      };
      const INIT_SUBSCRIPT = {
        match: [
          /\b(?:subscript|init[?!]?)/,
          /\s*(?=[<(])/
        ],
        className: { 1: "keyword" },
        contains: [
          GENERIC_PARAMETERS,
          FUNCTION_PARAMETERS,
          WHITESPACE
        ],
        illegal: /\[|%/
      };
      const OPERATOR_DECLARATION = {
        match: [
          /operator/,
          /\s+/,
          operator
        ],
        className: {
          1: "keyword",
          3: "title"
        }
      };
      const PRECEDENCEGROUP = {
        begin: [
          /precedencegroup/,
          /\s+/,
          typeIdentifier
        ],
        className: {
          1: "keyword",
          3: "title"
        },
        contains: [TYPE],
        keywords: [
          ...precedencegroupKeywords,
          ...literals
        ],
        end: /}/
      };
      const CLASS_FUNC_DECLARATION = {
        match: [
          /class\b/,
          /\s+/,
          /func\b/,
          /\s+/,
          /\b[A-Za-z_][A-Za-z0-9_]*\b/
        ],
        scope: {
          1: "keyword",
          3: "keyword",
          5: "title.function"
        }
      };
      const CLASS_VAR_DECLARATION = {
        match: [
          /class\b/,
          /\s+/,
          /var\b/
        ],
        scope: {
          1: "keyword",
          3: "keyword"
        }
      };
      const TYPE_DECLARATION = {
        begin: [
          /(struct|protocol|class|extension|enum|actor)/,
          /\s+/,
          identifier,
          /\s*/
        ],
        beginScope: {
          1: "keyword",
          3: "title.class"
        },
        keywords: KEYWORDS,
        contains: [
          GENERIC_PARAMETERS,
          ...KEYWORD_MODES,
          {
            begin: /:/,
            end: /\{/,
            keywords: KEYWORDS,
            contains: [
              {
                scope: "title.class.inherited",
                match: typeIdentifier
              },
              ...KEYWORD_MODES
            ],
            relevance: 0
          }
        ]
      };
      for (const variant of STRING.variants) {
        const interpolation = variant.contains.find((mode) => mode.label === "interpol");
        interpolation.keywords = KEYWORDS;
        const submodes = [
          ...KEYWORD_MODES,
          ...BUILT_INS,
          ...OPERATORS,
          NUMBER,
          STRING,
          ...IDENTIFIERS
        ];
        interpolation.contains = [
          ...submodes,
          {
            begin: /\(/,
            end: /\)/,
            contains: [
              "self",
              ...submodes
            ]
          }
        ];
      }
      return {
        name: "Swift",
        keywords: KEYWORDS,
        contains: [
          ...COMMENTS,
          FUNCTION_OR_MACRO,
          INIT_SUBSCRIPT,
          CLASS_FUNC_DECLARATION,
          CLASS_VAR_DECLARATION,
          TYPE_DECLARATION,
          OPERATOR_DECLARATION,
          PRECEDENCEGROUP,
          {
            beginKeywords: "import",
            end: /$/,
            contains: [...COMMENTS],
            relevance: 0
          },
          REGEXP,
          ...KEYWORD_MODES,
          ...BUILT_INS,
          ...OPERATORS,
          NUMBER,
          STRING,
          ...IDENTIFIERS,
          ...ATTRIBUTES,
          TYPE,
          TUPLE
        ]
      };
    }
    module.exports = swift;
  }
});

// node_modules/highlight.js/lib/languages/yaml.js
var require_yaml = __commonJS({
  "node_modules/highlight.js/lib/languages/yaml.js"(exports, module) {
    function yaml(hljs) {
      const LITERALS = "true false yes no null";
      const URI_CHARACTERS = "[\\w#;/?:@&=+$,.~*'()[\\]]+";
      const KEY = {
        className: "attr",
        variants: [
          // added brackets support and special char support
          { begin: /[\w*@][\w*@ :()\./-]*:(?=[ \t]|$)/ },
          {
            // double quoted keys - with brackets and special char support
            begin: /"[\w*@][\w*@ :()\./-]*":(?=[ \t]|$)/
          },
          {
            // single quoted keys - with brackets and special char support
            begin: /'[\w*@][\w*@ :()\./-]*':(?=[ \t]|$)/
          }
        ]
      };
      const TEMPLATE_VARIABLES = {
        className: "template-variable",
        variants: [
          {
            // jinja templates Ansible
            begin: /\{\{/,
            end: /\}\}/
          },
          {
            // Ruby i18n
            begin: /%\{/,
            end: /\}/
          }
        ]
      };
      const SINGLE_QUOTE_STRING = {
        className: "string",
        relevance: 0,
        begin: /'/,
        end: /'/,
        contains: [
          {
            match: /''/,
            scope: "char.escape",
            relevance: 0
          }
        ]
      };
      const STRING = {
        className: "string",
        relevance: 0,
        variants: [
          {
            begin: /"/,
            end: /"/
          },
          { begin: /\S+/ }
        ],
        contains: [
          hljs.BACKSLASH_ESCAPE,
          TEMPLATE_VARIABLES
        ]
      };
      const CONTAINER_STRING = hljs.inherit(STRING, { variants: [
        {
          begin: /'/,
          end: /'/,
          contains: [
            {
              begin: /''/,
              relevance: 0
            }
          ]
        },
        {
          begin: /"/,
          end: /"/
        },
        { begin: /[^\s,{}[\]]+/ }
      ] });
      const DATE_RE = "[0-9]{4}(-[0-9][0-9]){0,2}";
      const TIME_RE = "([Tt \\t][0-9][0-9]?(:[0-9][0-9]){2})?";
      const FRACTION_RE = "(\\.[0-9]*)?";
      const ZONE_RE = "([ \\t])*(Z|[-+][0-9][0-9]?(:[0-9][0-9])?)?";
      const TIMESTAMP = {
        className: "number",
        begin: "\\b" + DATE_RE + TIME_RE + FRACTION_RE + ZONE_RE + "\\b"
      };
      const VALUE_CONTAINER = {
        end: ",",
        endsWithParent: true,
        excludeEnd: true,
        keywords: LITERALS,
        relevance: 0
      };
      const OBJECT = {
        begin: /\{/,
        end: /\}/,
        contains: [VALUE_CONTAINER],
        illegal: "\\n",
        relevance: 0
      };
      const ARRAY = {
        begin: "\\[",
        end: "\\]",
        contains: [VALUE_CONTAINER],
        illegal: "\\n",
        relevance: 0
      };
      const MODES = [
        KEY,
        {
          className: "meta",
          begin: "^---\\s*$",
          relevance: 10
        },
        {
          // multi line string
          // Blocks start with a | or > followed by a newline
          //
          // Indentation of subsequent lines must be the same to
          // be considered part of the block
          className: "string",
          begin: "[\\|>]([1-9]?[+-])?[ ]*\\n( +)[^ ][^\\n]*\\n(\\2[^\\n]+\\n?)*"
        },
        {
          // Ruby/Rails erb
          begin: "<%[%=-]?",
          end: "[%-]?%>",
          subLanguage: "ruby",
          excludeBegin: true,
          excludeEnd: true,
          relevance: 0
        },
        {
          // named tags
          className: "type",
          begin: "!\\w+!" + URI_CHARACTERS
        },
        // https://yaml.org/spec/1.2/spec.html#id2784064
        {
          // verbatim tags
          className: "type",
          begin: "!<" + URI_CHARACTERS + ">"
        },
        {
          // primary tags
          className: "type",
          begin: "!" + URI_CHARACTERS
        },
        {
          // secondary tags
          className: "type",
          begin: "!!" + URI_CHARACTERS
        },
        {
          // fragment id &ref
          className: "meta",
          begin: "&" + hljs.UNDERSCORE_IDENT_RE + "$"
        },
        {
          // fragment reference *ref
          className: "meta",
          begin: "\\*" + hljs.UNDERSCORE_IDENT_RE + "$"
        },
        {
          // array listing
          className: "bullet",
          // TODO: remove |$ hack when we have proper look-ahead support
          begin: "-(?=[ ]|$)",
          relevance: 0
        },
        hljs.HASH_COMMENT_MODE,
        {
          beginKeywords: LITERALS,
          keywords: { literal: LITERALS }
        },
        TIMESTAMP,
        // numbers are any valid C-style number that
        // sit isolated from other words
        {
          className: "number",
          begin: hljs.C_NUMBER_RE + "\\b",
          relevance: 0
        },
        OBJECT,
        ARRAY,
        SINGLE_QUOTE_STRING,
        STRING
      ];
      const VALUE_MODES = [...MODES];
      VALUE_MODES.pop();
      VALUE_MODES.push(CONTAINER_STRING);
      VALUE_CONTAINER.contains = VALUE_MODES;
      return {
        name: "YAML",
        case_insensitive: true,
        aliases: ["yml"],
        contains: MODES
      };
    }
    module.exports = yaml;
  }
});

// node_modules/highlight.js/lib/languages/typescript.js
var require_typescript = __commonJS({
  "node_modules/highlight.js/lib/languages/typescript.js"(exports, module) {
    var IDENT_RE = "[A-Za-z$_][0-9A-Za-z$_]*";
    var KEYWORDS = [
      "as",
      // for exports
      "in",
      "of",
      "if",
      "for",
      "while",
      "finally",
      "var",
      "new",
      "function",
      "do",
      "return",
      "void",
      "else",
      "break",
      "catch",
      "instanceof",
      "with",
      "throw",
      "case",
      "default",
      "try",
      "switch",
      "continue",
      "typeof",
      "delete",
      "let",
      "yield",
      "const",
      "class",
      // JS handles these with a special rule
      // "get",
      // "set",
      "debugger",
      "async",
      "await",
      "static",
      "import",
      "from",
      "export",
      "extends",
      // It's reached stage 3, which is "recommended for implementation":
      "using"
    ];
    var LITERALS = [
      "true",
      "false",
      "null",
      "undefined",
      "NaN",
      "Infinity"
    ];
    var TYPES = [
      // Fundamental objects
      "Object",
      "Function",
      "Boolean",
      "Symbol",
      // numbers and dates
      "Math",
      "Date",
      "Number",
      "BigInt",
      // text
      "String",
      "RegExp",
      // Indexed collections
      "Array",
      "Float32Array",
      "Float64Array",
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Int32Array",
      "Uint16Array",
      "Uint32Array",
      "BigInt64Array",
      "BigUint64Array",
      // Keyed collections
      "Set",
      "Map",
      "WeakSet",
      "WeakMap",
      // Structured data
      "ArrayBuffer",
      "SharedArrayBuffer",
      "Atomics",
      "DataView",
      "JSON",
      // Control abstraction objects
      "Promise",
      "Generator",
      "GeneratorFunction",
      "AsyncFunction",
      // Reflection
      "Reflect",
      "Proxy",
      // Internationalization
      "Intl",
      // WebAssembly
      "WebAssembly"
    ];
    var ERROR_TYPES = [
      "Error",
      "EvalError",
      "InternalError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "TypeError",
      "URIError"
    ];
    var BUILT_IN_GLOBALS = [
      "setInterval",
      "setTimeout",
      "clearInterval",
      "clearTimeout",
      "require",
      "exports",
      "eval",
      "isFinite",
      "isNaN",
      "parseFloat",
      "parseInt",
      "decodeURI",
      "decodeURIComponent",
      "encodeURI",
      "encodeURIComponent",
      "escape",
      "unescape"
    ];
    var BUILT_IN_VARIABLES = [
      "arguments",
      "this",
      "super",
      "console",
      "window",
      "document",
      "localStorage",
      "sessionStorage",
      "module",
      "global"
      // Node.js
    ];
    var BUILT_INS = [].concat(
      BUILT_IN_GLOBALS,
      TYPES,
      ERROR_TYPES
    );
    function javascript(hljs) {
      const regex = hljs.regex;
      const hasClosingTag = (match2, { after }) => {
        const tag = "</" + match2[0].slice(1);
        const pos = match2.input.indexOf(tag, after);
        return pos !== -1;
      };
      const IDENT_RE$1 = IDENT_RE;
      const FRAGMENT = {
        begin: "<>",
        end: "</>"
      };
      const XML_SELF_CLOSING = /<[A-Za-z0-9\\._:-]+\s*\/>/;
      const XML_TAG = {
        begin: /<[A-Za-z0-9\\._:-]+/,
        end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
        /**
         * @param {RegExpMatchArray} match
         * @param {CallbackResponse} response
         */
        isTrulyOpeningTag: (match2, response) => {
          const afterMatchIndex = match2[0].length + match2.index;
          const nextChar = match2.input[afterMatchIndex];
          if (
            // HTML should not include another raw `<` inside a tag
            // nested type?
            // `<Array<Array<number>>`, etc.
            nextChar === "<" || // the , gives away that this is not HTML
            // `<T, A extends keyof T, V>`
            nextChar === ","
          ) {
            response.ignoreMatch();
            return;
          }
          if (nextChar === ">") {
            if (!hasClosingTag(match2, { after: afterMatchIndex })) {
              response.ignoreMatch();
            }
          }
          let m6;
          const afterMatch = match2.input.substring(afterMatchIndex);
          if (m6 = afterMatch.match(/^\s*=/)) {
            response.ignoreMatch();
            return;
          }
          if (m6 = afterMatch.match(/^\s+extends\s+/)) {
            if (m6.index === 0) {
              response.ignoreMatch();
              return;
            }
          }
        }
      };
      const KEYWORDS$1 = {
        $pattern: IDENT_RE,
        keyword: KEYWORDS,
        literal: LITERALS,
        built_in: BUILT_INS,
        "variable.language": BUILT_IN_VARIABLES
      };
      const decimalDigits = "[0-9](_?[0-9])*";
      const frac = `\\.(${decimalDigits})`;
      const decimalInteger = `0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*`;
      const NUMBER = {
        className: "number",
        variants: [
          // DecimalLiteral
          { begin: `(\\b(${decimalInteger})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})\\b` },
          { begin: `\\b(${decimalInteger})\\b((${frac})\\b|\\.)?|(${frac})\\b` },
          // DecimalBigIntegerLiteral
          { begin: `\\b(0|[1-9](_?[0-9])*)n\\b` },
          // NonDecimalIntegerLiteral
          { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
          { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
          { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
          // LegacyOctalIntegerLiteral (does not include underscore separators)
          // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
          { begin: "\\b0[0-7]+n?\\b" }
        ],
        relevance: 0
      };
      const SUBST = {
        className: "subst",
        begin: "\\$\\{",
        end: "\\}",
        keywords: KEYWORDS$1,
        contains: []
        // defined later
      };
      const HTML_TEMPLATE = {
        begin: ".?html`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "xml"
        }
      };
      const CSS_TEMPLATE = {
        begin: ".?css`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "css"
        }
      };
      const GRAPHQL_TEMPLATE = {
        begin: ".?gql`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "graphql"
        }
      };
      const TEMPLATE_STRING = {
        className: "string",
        begin: "`",
        end: "`",
        contains: [
          hljs.BACKSLASH_ESCAPE,
          SUBST
        ]
      };
      const JSDOC_COMMENT = hljs.COMMENT(
        /\/\*\*(?!\/)/,
        "\\*/",
        {
          relevance: 0,
          contains: [
            {
              begin: "(?=@[A-Za-z]+)",
              relevance: 0,
              contains: [
                {
                  className: "doctag",
                  begin: "@[A-Za-z]+"
                },
                {
                  className: "type",
                  begin: "\\{",
                  end: "\\}",
                  excludeEnd: true,
                  excludeBegin: true,
                  relevance: 0
                },
                {
                  className: "variable",
                  begin: IDENT_RE$1 + "(?=\\s*(-)|$)",
                  endsParent: true,
                  relevance: 0
                },
                // eat spaces (not newlines) so we can find
                // types or variables
                {
                  begin: /(?=[^\n])\s/,
                  relevance: 0
                }
              ]
            }
          ]
        }
      );
      const COMMENT = {
        className: "comment",
        variants: [
          JSDOC_COMMENT,
          hljs.C_BLOCK_COMMENT_MODE,
          hljs.C_LINE_COMMENT_MODE
        ]
      };
      const SUBST_INTERNALS = [
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE,
        HTML_TEMPLATE,
        CSS_TEMPLATE,
        GRAPHQL_TEMPLATE,
        TEMPLATE_STRING,
        // Skip numbers when they are part of a variable name
        { match: /\$\d+/ },
        NUMBER
        // This is intentional:
        // See https://github.com/highlightjs/highlight.js/issues/3288
        // hljs.REGEXP_MODE
      ];
      SUBST.contains = SUBST_INTERNALS.concat({
        // we need to pair up {} inside our subst to prevent
        // it from ending too early by matching another }
        begin: /\{/,
        end: /\}/,
        keywords: KEYWORDS$1,
        contains: [
          "self"
        ].concat(SUBST_INTERNALS)
      });
      const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
      const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
        // eat recursive parens in sub expressions
        {
          begin: /(\s*)\(/,
          end: /\)/,
          keywords: KEYWORDS$1,
          contains: ["self"].concat(SUBST_AND_COMMENTS)
        }
      ]);
      const PARAMS = {
        className: "params",
        // convert this to negative lookbehind in v12
        begin: /(\s*)\(/,
        // to match the parms with
        end: /\)/,
        excludeBegin: true,
        excludeEnd: true,
        keywords: KEYWORDS$1,
        contains: PARAMS_CONTAINS
      };
      const CLASS_OR_EXTENDS = {
        variants: [
          // class Car extends vehicle
          {
            match: [
              /class/,
              /\s+/,
              IDENT_RE$1,
              /\s+/,
              /extends/,
              /\s+/,
              regex.concat(IDENT_RE$1, "(", regex.concat(/\./, IDENT_RE$1), ")*")
            ],
            scope: {
              1: "keyword",
              3: "title.class",
              5: "keyword",
              7: "title.class.inherited"
            }
          },
          // class Car
          {
            match: [
              /class/,
              /\s+/,
              IDENT_RE$1
            ],
            scope: {
              1: "keyword",
              3: "title.class"
            }
          }
        ]
      };
      const CLASS_REFERENCE = {
        relevance: 0,
        match: regex.either(
          // Hard coded exceptions
          /\bJSON/,
          // Float32Array, OutT
          /\b[A-Z][a-z]+([A-Z][a-z]*|\d)*/,
          // CSSFactory, CSSFactoryT
          /\b[A-Z]{2,}([A-Z][a-z]+|\d)+([A-Z][a-z]*)*/,
          // FPs, FPsT
          /\b[A-Z]{2,}[a-z]+([A-Z][a-z]+|\d)*([A-Z][a-z]*)*/
          // P
          // single letters are not highlighted
          // BLAH
          // this will be flagged as a UPPER_CASE_CONSTANT instead
        ),
        className: "title.class",
        keywords: {
          _: [
            // se we still get relevance credit for JS library classes
            ...TYPES,
            ...ERROR_TYPES
          ]
        }
      };
      const USE_STRICT = {
        label: "use_strict",
        className: "meta",
        relevance: 10,
        begin: /^\s*['"]use (strict|asm)['"]/
      };
      const FUNCTION_DEFINITION = {
        variants: [
          {
            match: [
              /function/,
              /\s+/,
              IDENT_RE$1,
              /(?=\s*\()/
            ]
          },
          // anonymous function
          {
            match: [
              /function/,
              /\s*(?=\()/
            ]
          }
        ],
        className: {
          1: "keyword",
          3: "title.function"
        },
        label: "func.def",
        contains: [PARAMS],
        illegal: /%/
      };
      const UPPER_CASE_CONSTANT = {
        relevance: 0,
        match: /\b[A-Z][A-Z_0-9]+\b/,
        className: "variable.constant"
      };
      function noneOf(list) {
        return regex.concat("(?!", list.join("|"), ")");
      }
      const FUNCTION_CALL = {
        match: regex.concat(
          /\b/,
          noneOf([
            ...BUILT_IN_GLOBALS,
            "super",
            "import"
          ].map((x6) => `${x6}\\s*\\(`)),
          IDENT_RE$1,
          regex.lookahead(/\s*\(/)
        ),
        className: "title.function",
        relevance: 0
      };
      const PROPERTY_ACCESS = {
        begin: regex.concat(/\./, regex.lookahead(
          regex.concat(IDENT_RE$1, /(?![0-9A-Za-z$_(])/)
        )),
        end: IDENT_RE$1,
        excludeBegin: true,
        keywords: "prototype",
        className: "property",
        relevance: 0
      };
      const GETTER_OR_SETTER = {
        match: [
          /get|set/,
          /\s+/,
          IDENT_RE$1,
          /(?=\()/
        ],
        className: {
          1: "keyword",
          3: "title.function"
        },
        contains: [
          {
            // eat to avoid empty params
            begin: /\(\)/
          },
          PARAMS
        ]
      };
      const FUNC_LEAD_IN_RE = "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + hljs.UNDERSCORE_IDENT_RE + ")\\s*=>";
      const FUNCTION_VARIABLE = {
        match: [
          /const|var|let/,
          /\s+/,
          IDENT_RE$1,
          /\s*/,
          /=\s*/,
          /(async\s*)?/,
          // async is optional
          regex.lookahead(FUNC_LEAD_IN_RE)
        ],
        keywords: "async",
        className: {
          1: "keyword",
          3: "title.function"
        },
        contains: [
          PARAMS
        ]
      };
      return {
        name: "JavaScript",
        aliases: ["js", "jsx", "mjs", "cjs"],
        keywords: KEYWORDS$1,
        // this will be extended by TypeScript
        exports: { PARAMS_CONTAINS, CLASS_REFERENCE },
        illegal: /#(?![$_A-z])/,
        contains: [
          hljs.SHEBANG({
            label: "shebang",
            binary: "node",
            relevance: 5
          }),
          USE_STRICT,
          hljs.APOS_STRING_MODE,
          hljs.QUOTE_STRING_MODE,
          HTML_TEMPLATE,
          CSS_TEMPLATE,
          GRAPHQL_TEMPLATE,
          TEMPLATE_STRING,
          COMMENT,
          // Skip numbers when they are part of a variable name
          { match: /\$\d+/ },
          NUMBER,
          CLASS_REFERENCE,
          {
            scope: "attr",
            match: IDENT_RE$1 + regex.lookahead(":"),
            relevance: 0
          },
          FUNCTION_VARIABLE,
          {
            // "value" container
            begin: "(" + hljs.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
            keywords: "return throw case",
            relevance: 0,
            contains: [
              COMMENT,
              hljs.REGEXP_MODE,
              {
                className: "function",
                // we have to count the parens to make sure we actually have the
                // correct bounding ( ) before the =>.  There could be any number of
                // sub-expressions inside also surrounded by parens.
                begin: FUNC_LEAD_IN_RE,
                returnBegin: true,
                end: "\\s*=>",
                contains: [
                  {
                    className: "params",
                    variants: [
                      {
                        begin: hljs.UNDERSCORE_IDENT_RE,
                        relevance: 0
                      },
                      {
                        className: null,
                        begin: /\(\s*\)/,
                        skip: true
                      },
                      {
                        begin: /(\s*)\(/,
                        end: /\)/,
                        excludeBegin: true,
                        excludeEnd: true,
                        keywords: KEYWORDS$1,
                        contains: PARAMS_CONTAINS
                      }
                    ]
                  }
                ]
              },
              {
                // could be a comma delimited list of params to a function call
                begin: /,/,
                relevance: 0
              },
              {
                match: /\s+/,
                relevance: 0
              },
              {
                // JSX
                variants: [
                  { begin: FRAGMENT.begin, end: FRAGMENT.end },
                  { match: XML_SELF_CLOSING },
                  {
                    begin: XML_TAG.begin,
                    // we carefully check the opening tag to see if it truly
                    // is a tag and not a false positive
                    "on:begin": XML_TAG.isTrulyOpeningTag,
                    end: XML_TAG.end
                  }
                ],
                subLanguage: "xml",
                contains: [
                  {
                    begin: XML_TAG.begin,
                    end: XML_TAG.end,
                    skip: true,
                    contains: ["self"]
                  }
                ]
              }
            ]
          },
          FUNCTION_DEFINITION,
          {
            // prevent this from getting swallowed up by function
            // since they appear "function like"
            beginKeywords: "while if switch catch for"
          },
          {
            // we have to count the parens to make sure we actually have the correct
            // bounding ( ).  There could be any number of sub-expressions inside
            // also surrounded by parens.
            begin: "\\b(?!function)" + hljs.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
            // end parens
            returnBegin: true,
            label: "func.def",
            contains: [
              PARAMS,
              hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1, className: "title.function" })
            ]
          },
          // catch ... so it won't trigger the property rule below
          {
            match: /\.\.\./,
            relevance: 0
          },
          PROPERTY_ACCESS,
          // hack: prevents detection of keywords in some circumstances
          // .keyword()
          // $keyword = x
          {
            match: "\\$" + IDENT_RE$1,
            relevance: 0
          },
          {
            match: [/\bconstructor(?=\s*\()/],
            className: { 1: "title.function" },
            contains: [PARAMS]
          },
          FUNCTION_CALL,
          UPPER_CASE_CONSTANT,
          CLASS_OR_EXTENDS,
          GETTER_OR_SETTER,
          {
            match: /\$[(.]/
            // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
          }
        ]
      };
    }
    function typescript(hljs) {
      const regex = hljs.regex;
      const tsLanguage = javascript(hljs);
      const IDENT_RE$1 = IDENT_RE;
      const TYPES2 = [
        "any",
        "void",
        "number",
        "boolean",
        "string",
        "object",
        "never",
        "symbol",
        "bigint",
        "unknown"
      ];
      const NAMESPACE = {
        begin: [
          /namespace/,
          /\s+/,
          hljs.IDENT_RE
        ],
        beginScope: {
          1: "keyword",
          3: "title.class"
        }
      };
      const INTERFACE = {
        beginKeywords: "interface",
        end: /\{/,
        excludeEnd: true,
        keywords: {
          keyword: "interface extends",
          built_in: TYPES2
        },
        contains: [tsLanguage.exports.CLASS_REFERENCE]
      };
      const USE_STRICT = {
        className: "meta",
        relevance: 10,
        begin: /^\s*['"]use strict['"]/
      };
      const TS_SPECIFIC_KEYWORDS = [
        "type",
        // "namespace",
        "interface",
        "public",
        "private",
        "protected",
        "implements",
        "declare",
        "abstract",
        "readonly",
        "enum",
        "override",
        "satisfies"
      ];
      const KEYWORDS$1 = {
        $pattern: IDENT_RE,
        keyword: KEYWORDS.concat(TS_SPECIFIC_KEYWORDS),
        literal: LITERALS,
        built_in: BUILT_INS.concat(TYPES2),
        "variable.language": BUILT_IN_VARIABLES
      };
      const DECORATOR = {
        className: "meta",
        begin: "@" + IDENT_RE$1
      };
      const swapMode = (mode, label, replacement) => {
        const indx = mode.contains.findIndex((m6) => m6.label === label);
        if (indx === -1) {
          throw new Error("can not find mode to replace");
        }
        mode.contains.splice(indx, 1, replacement);
      };
      Object.assign(tsLanguage.keywords, KEYWORDS$1);
      tsLanguage.exports.PARAMS_CONTAINS.push(DECORATOR);
      const ATTRIBUTE_HIGHLIGHT = tsLanguage.contains.find((c4) => c4.scope === "attr");
      const OPTIONAL_KEY_OR_ARGUMENT = Object.assign(
        {},
        ATTRIBUTE_HIGHLIGHT,
        { match: regex.concat(IDENT_RE$1, regex.lookahead(/\s*\?:/)) }
      );
      tsLanguage.exports.PARAMS_CONTAINS.push([
        tsLanguage.exports.CLASS_REFERENCE,
        // class reference for highlighting the params types
        ATTRIBUTE_HIGHLIGHT,
        // highlight the params key
        OPTIONAL_KEY_OR_ARGUMENT
        // Added for optional property assignment highlighting
      ]);
      tsLanguage.contains = tsLanguage.contains.concat([
        DECORATOR,
        NAMESPACE,
        INTERFACE,
        OPTIONAL_KEY_OR_ARGUMENT
        // Added for optional property assignment highlighting
      ]);
      swapMode(tsLanguage, "shebang", hljs.SHEBANG());
      swapMode(tsLanguage, "use_strict", USE_STRICT);
      const functionDeclaration = tsLanguage.contains.find((m6) => m6.label === "func.def");
      functionDeclaration.relevance = 0;
      Object.assign(tsLanguage, {
        name: "TypeScript",
        aliases: [
          "ts",
          "tsx",
          "mts",
          "cts"
        ]
      });
      return tsLanguage;
    }
    module.exports = typescript;
  }
});

// node_modules/highlight.js/lib/languages/vbnet.js
var require_vbnet = __commonJS({
  "node_modules/highlight.js/lib/languages/vbnet.js"(exports, module) {
    function vbnet(hljs) {
      const regex = hljs.regex;
      const CHARACTER = {
        className: "string",
        begin: /"(""|[^/n])"C\b/
      };
      const STRING = {
        className: "string",
        begin: /"/,
        end: /"/,
        illegal: /\n/,
        contains: [
          {
            // double quote escape
            begin: /""/
          }
        ]
      };
      const MM_DD_YYYY = /\d{1,2}\/\d{1,2}\/\d{4}/;
      const YYYY_MM_DD = /\d{4}-\d{1,2}-\d{1,2}/;
      const TIME_12H = /(\d|1[012])(:\d+){0,2} *(AM|PM)/;
      const TIME_24H = /\d{1,2}(:\d{1,2}){1,2}/;
      const DATE = {
        className: "literal",
        variants: [
          {
            // #YYYY-MM-DD# (ISO-Date) or #M/D/YYYY# (US-Date)
            begin: regex.concat(/# */, regex.either(YYYY_MM_DD, MM_DD_YYYY), / *#/)
          },
          {
            // #H:mm[:ss]# (24h Time)
            begin: regex.concat(/# */, TIME_24H, / *#/)
          },
          {
            // #h[:mm[:ss]] A# (12h Time)
            begin: regex.concat(/# */, TIME_12H, / *#/)
          },
          {
            // date plus time
            begin: regex.concat(
              /# */,
              regex.either(YYYY_MM_DD, MM_DD_YYYY),
              / +/,
              regex.either(TIME_12H, TIME_24H),
              / *#/
            )
          }
        ]
      };
      const NUMBER = {
        className: "number",
        relevance: 0,
        variants: [
          {
            // Float
            begin: /\b\d[\d_]*((\.[\d_]+(E[+-]?[\d_]+)?)|(E[+-]?[\d_]+))[RFD@!#]?/
          },
          {
            // Integer (base 10)
            begin: /\b\d[\d_]*((U?[SIL])|[%&])?/
          },
          {
            // Integer (base 16)
            begin: /&H[\dA-F_]+((U?[SIL])|[%&])?/
          },
          {
            // Integer (base 8)
            begin: /&O[0-7_]+((U?[SIL])|[%&])?/
          },
          {
            // Integer (base 2)
            begin: /&B[01_]+((U?[SIL])|[%&])?/
          }
        ]
      };
      const LABEL = {
        className: "label",
        begin: /^\w+:/
      };
      const DOC_COMMENT = hljs.COMMENT(/'''/, /$/, { contains: [
        {
          className: "doctag",
          begin: /<\/?/,
          end: />/
        }
      ] });
      const COMMENT = hljs.COMMENT(null, /$/, { variants: [
        { begin: /'/ },
        {
          // TODO: Use multi-class for leading spaces
          begin: /([\t ]|^)REM(?=\s)/
        }
      ] });
      const DIRECTIVES = {
        className: "meta",
        // TODO: Use multi-class for indentation once available
        begin: /[\t ]*#(const|disable|else|elseif|enable|end|externalsource|if|region)\b/,
        end: /$/,
        keywords: { keyword: "const disable else elseif enable end externalsource if region then" },
        contains: [COMMENT]
      };
      return {
        name: "Visual Basic .NET",
        aliases: ["vb"],
        case_insensitive: true,
        classNameAliases: { label: "symbol" },
        keywords: {
          keyword: "addhandler alias aggregate ansi as async assembly auto binary by byref byval call case catch class compare const continue custom declare default delegate dim distinct do each equals else elseif end enum erase error event exit explicit finally for friend from function get global goto group handles if implements imports in inherits interface into iterator join key let lib loop me mid module mustinherit mustoverride mybase myclass namespace narrowing new next notinheritable notoverridable of off on operator option optional order overloads overridable overrides paramarray partial preserve private property protected public raiseevent readonly redim removehandler resume return select set shadows shared skip static step stop structure strict sub synclock take text then throw to try unicode until using when where while widening with withevents writeonly yield",
          built_in: (
            // Operators https://docs.microsoft.com/dotnet/visual-basic/language-reference/operators
            "addressof and andalso await directcast gettype getxmlnamespace is isfalse isnot istrue like mod nameof new not or orelse trycast typeof xor cbool cbyte cchar cdate cdbl cdec cint clng cobj csbyte cshort csng cstr cuint culng cushort"
          ),
          type: (
            // Data types https://docs.microsoft.com/dotnet/visual-basic/language-reference/data-types
            "boolean byte char date decimal double integer long object sbyte short single string uinteger ulong ushort"
          ),
          literal: "true false nothing"
        },
        illegal: "//|\\{|\\}|endif|gosub|variant|wend|^\\$ ",
        contains: [
          CHARACTER,
          STRING,
          DATE,
          NUMBER,
          LABEL,
          DOC_COMMENT,
          COMMENT,
          DIRECTIVES
        ]
      };
    }
    module.exports = vbnet;
  }
});

// node_modules/highlight.js/lib/languages/wasm.js
var require_wasm = __commonJS({
  "node_modules/highlight.js/lib/languages/wasm.js"(exports, module) {
    function wasm(hljs) {
      hljs.regex;
      const BLOCK_COMMENT = hljs.COMMENT(/\(;/, /;\)/);
      BLOCK_COMMENT.contains.push("self");
      const LINE_COMMENT = hljs.COMMENT(/;;/, /$/);
      const KWS = [
        "anyfunc",
        "block",
        "br",
        "br_if",
        "br_table",
        "call",
        "call_indirect",
        "data",
        "drop",
        "elem",
        "else",
        "end",
        "export",
        "func",
        "global.get",
        "global.set",
        "local.get",
        "local.set",
        "local.tee",
        "get_global",
        "get_local",
        "global",
        "if",
        "import",
        "local",
        "loop",
        "memory",
        "memory.grow",
        "memory.size",
        "module",
        "mut",
        "nop",
        "offset",
        "param",
        "result",
        "return",
        "select",
        "set_global",
        "set_local",
        "start",
        "table",
        "tee_local",
        "then",
        "type",
        "unreachable"
      ];
      const FUNCTION_REFERENCE = {
        begin: [
          /(?:func|call|call_indirect)/,
          /\s+/,
          /\$[^\s)]+/
        ],
        className: {
          1: "keyword",
          3: "title.function"
        }
      };
      const ARGUMENT = {
        className: "variable",
        begin: /\$[\w_]+/
      };
      const PARENS = {
        match: /(\((?!;)|\))+/,
        className: "punctuation",
        relevance: 0
      };
      const NUMBER = {
        className: "number",
        relevance: 0,
        // borrowed from Prism, TODO: split out into variants
        match: /[+-]?\b(?:\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|0x[\da-fA-F](?:_?[\da-fA-F])*(?:\.[\da-fA-F](?:_?[\da-fA-D])*)?(?:[pP][+-]?\d(?:_?\d)*)?)\b|\binf\b|\bnan(?::0x[\da-fA-F](?:_?[\da-fA-D])*)?\b/
      };
      const TYPE = {
        // look-ahead prevents us from gobbling up opcodes
        match: /(i32|i64|f32|f64)(?!\.)/,
        className: "type"
      };
      const MATH_OPERATIONS = {
        className: "keyword",
        // borrowed from Prism, TODO: split out into variants
        match: /\b(f32|f64|i32|i64)(?:\.(?:abs|add|and|ceil|clz|const|convert_[su]\/i(?:32|64)|copysign|ctz|demote\/f64|div(?:_[su])?|eqz?|extend_[su]\/i32|floor|ge(?:_[su])?|gt(?:_[su])?|le(?:_[su])?|load(?:(?:8|16|32)_[su])?|lt(?:_[su])?|max|min|mul|nearest|neg?|or|popcnt|promote\/f32|reinterpret\/[fi](?:32|64)|rem_[su]|rot[lr]|shl|shr_[su]|store(?:8|16|32)?|sqrt|sub|trunc(?:_[su]\/f(?:32|64))?|wrap\/i64|xor))\b/
      };
      const OFFSET_ALIGN = {
        match: [
          /(?:offset|align)/,
          /\s*/,
          /=/
        ],
        className: {
          1: "keyword",
          3: "operator"
        }
      };
      return {
        name: "WebAssembly",
        keywords: {
          $pattern: /[\w.]+/,
          keyword: KWS
        },
        contains: [
          LINE_COMMENT,
          BLOCK_COMMENT,
          OFFSET_ALIGN,
          ARGUMENT,
          PARENS,
          FUNCTION_REFERENCE,
          hljs.QUOTE_STRING_MODE,
          TYPE,
          MATH_OPERATIONS,
          NUMBER
        ]
      };
    }
    module.exports = wasm;
  }
});

// node_modules/highlight.js/lib/common.js
var require_common = __commonJS({
  "node_modules/highlight.js/lib/common.js"(exports, module) {
    var hljs = require_core();
    hljs.registerLanguage("xml", require_xml());
    hljs.registerLanguage("bash", require_bash());
    hljs.registerLanguage("c", require_c());
    hljs.registerLanguage("cpp", require_cpp());
    hljs.registerLanguage("csharp", require_csharp());
    hljs.registerLanguage("css", require_css());
    hljs.registerLanguage("markdown", require_markdown());
    hljs.registerLanguage("diff", require_diff());
    hljs.registerLanguage("ruby", require_ruby());
    hljs.registerLanguage("go", require_go());
    hljs.registerLanguage("graphql", require_graphql());
    hljs.registerLanguage("ini", require_ini());
    hljs.registerLanguage("java", require_java());
    hljs.registerLanguage("javascript", require_javascript());
    hljs.registerLanguage("json", require_json());
    hljs.registerLanguage("kotlin", require_kotlin());
    hljs.registerLanguage("less", require_less());
    hljs.registerLanguage("lua", require_lua());
    hljs.registerLanguage("makefile", require_makefile());
    hljs.registerLanguage("perl", require_perl());
    hljs.registerLanguage("objectivec", require_objectivec());
    hljs.registerLanguage("php", require_php());
    hljs.registerLanguage("php-template", require_php_template());
    hljs.registerLanguage("plaintext", require_plaintext());
    hljs.registerLanguage("python", require_python());
    hljs.registerLanguage("python-repl", require_python_repl());
    hljs.registerLanguage("r", require_r());
    hljs.registerLanguage("rust", require_rust());
    hljs.registerLanguage("scss", require_scss());
    hljs.registerLanguage("shell", require_shell());
    hljs.registerLanguage("sql", require_sql());
    hljs.registerLanguage("swift", require_swift());
    hljs.registerLanguage("yaml", require_yaml());
    hljs.registerLanguage("typescript", require_typescript());
    hljs.registerLanguage("vbnet", require_vbnet());
    hljs.registerLanguage("wasm", require_wasm());
    hljs.HighlightJS = hljs;
    hljs.default = hljs;
    module.exports = hljs;
  }
});

// node_modules/preact/dist/preact.module.js
var n;
var l;
var u;
var t;
var i;
var r;
var o;
var e;
var f;
var c;
var s;
var a;
var h;
var p = {};
var v = [];
var y = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
var d = Array.isArray;
function w(n3, l7) {
  for (var u5 in l7) n3[u5] = l7[u5];
  return n3;
}
function _(n3) {
  n3 && n3.parentNode && n3.parentNode.removeChild(n3);
}
function g(l7, u5, t4) {
  var i5, r4, o4, e4 = {};
  for (o4 in u5) "key" == o4 ? i5 = u5[o4] : "ref" == o4 ? r4 = u5[o4] : e4[o4] = u5[o4];
  if (arguments.length > 2 && (e4.children = arguments.length > 3 ? n.call(arguments, 2) : t4), "function" == typeof l7 && null != l7.defaultProps) for (o4 in l7.defaultProps) void 0 === e4[o4] && (e4[o4] = l7.defaultProps[o4]);
  return m(l7, e4, i5, r4, null);
}
function m(n3, t4, i5, r4, o4) {
  var e4 = { type: n3, props: t4, key: i5, ref: r4, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: null == o4 ? ++u : o4, __i: -1, __u: 0 };
  return null == o4 && null != l.vnode && l.vnode(e4), e4;
}
function k(n3) {
  return n3.children;
}
function x(n3, l7) {
  this.props = n3, this.context = l7;
}
function C(n3, l7) {
  if (null == l7) return n3.__ ? C(n3.__, n3.__i + 1) : null;
  for (var u5; l7 < n3.__k.length; l7++) if (null != (u5 = n3.__k[l7]) && null != u5.__e) return u5.__e;
  return "function" == typeof n3.type ? C(n3) : null;
}
function S(n3) {
  var l7, u5;
  if (null != (n3 = n3.__) && null != n3.__c) {
    for (n3.__e = n3.__c.base = null, l7 = 0; l7 < n3.__k.length; l7++) if (null != (u5 = n3.__k[l7]) && null != u5.__e) {
      n3.__e = n3.__c.base = u5.__e;
      break;
    }
    return S(n3);
  }
}
function M(n3) {
  (!n3.__d && (n3.__d = true) && i.push(n3) && !P.__r++ || r !== l.debounceRendering) && ((r = l.debounceRendering) || o)(P);
}
function P() {
  var n3, u5, t4, r4, o4, f5, c4, s5;
  for (i.sort(e); n3 = i.shift(); ) n3.__d && (u5 = i.length, r4 = void 0, f5 = (o4 = (t4 = n3).__v).__e, c4 = [], s5 = [], t4.__P && ((r4 = w({}, o4)).__v = o4.__v + 1, l.vnode && l.vnode(r4), j(t4.__P, r4, o4, t4.__n, t4.__P.namespaceURI, 32 & o4.__u ? [f5] : null, c4, null == f5 ? C(o4) : f5, !!(32 & o4.__u), s5), r4.__v = o4.__v, r4.__.__k[r4.__i] = r4, z(c4, r4, s5), r4.__e != f5 && S(r4)), i.length > u5 && i.sort(e));
  P.__r = 0;
}
function $(n3, l7, u5, t4, i5, r4, o4, e4, f5, c4, s5) {
  var a4, h5, y5, d5, w5, _6, g8 = t4 && t4.__k || v, m6 = l7.length;
  for (f5 = I(u5, l7, g8, f5, m6), a4 = 0; a4 < m6; a4++) null != (y5 = u5.__k[a4]) && (h5 = -1 === y5.__i ? p : g8[y5.__i] || p, y5.__i = a4, _6 = j(n3, y5, h5, i5, r4, o4, e4, f5, c4, s5), d5 = y5.__e, y5.ref && h5.ref != y5.ref && (h5.ref && V(h5.ref, null, y5), s5.push(y5.ref, y5.__c || d5, y5)), null == w5 && null != d5 && (w5 = d5), 4 & y5.__u || h5.__k === y5.__k ? f5 = A(y5, f5, n3) : "function" == typeof y5.type && void 0 !== _6 ? f5 = _6 : d5 && (f5 = d5.nextSibling), y5.__u &= -7);
  return u5.__e = w5, f5;
}
function I(n3, l7, u5, t4, i5) {
  var r4, o4, e4, f5, c4, s5 = u5.length, a4 = s5, h5 = 0;
  for (n3.__k = new Array(i5), r4 = 0; r4 < i5; r4++) null != (o4 = l7[r4]) && "boolean" != typeof o4 && "function" != typeof o4 ? (f5 = r4 + h5, (o4 = n3.__k[r4] = "string" == typeof o4 || "number" == typeof o4 || "bigint" == typeof o4 || o4.constructor == String ? m(null, o4, null, null, null) : d(o4) ? m(k, { children: o4 }, null, null, null) : void 0 === o4.constructor && o4.__b > 0 ? m(o4.type, o4.props, o4.key, o4.ref ? o4.ref : null, o4.__v) : o4).__ = n3, o4.__b = n3.__b + 1, e4 = null, -1 !== (c4 = o4.__i = L(o4, u5, f5, a4)) && (a4--, (e4 = u5[c4]) && (e4.__u |= 2)), null == e4 || null === e4.__v ? (-1 == c4 && h5--, "function" != typeof o4.type && (o4.__u |= 4)) : c4 != f5 && (c4 == f5 - 1 ? h5-- : c4 == f5 + 1 ? h5++ : (c4 > f5 ? h5-- : h5++, o4.__u |= 4))) : n3.__k[r4] = null;
  if (a4) for (r4 = 0; r4 < s5; r4++) null != (e4 = u5[r4]) && 0 == (2 & e4.__u) && (e4.__e == t4 && (t4 = C(e4)), q(e4, e4));
  return t4;
}
function A(n3, l7, u5) {
  var t4, i5;
  if ("function" == typeof n3.type) {
    for (t4 = n3.__k, i5 = 0; t4 && i5 < t4.length; i5++) t4[i5] && (t4[i5].__ = n3, l7 = A(t4[i5], l7, u5));
    return l7;
  }
  n3.__e != l7 && (l7 && n3.type && !u5.contains(l7) && (l7 = C(n3)), u5.insertBefore(n3.__e, l7 || null), l7 = n3.__e);
  do {
    l7 = l7 && l7.nextSibling;
  } while (null != l7 && 8 == l7.nodeType);
  return l7;
}
function H(n3, l7) {
  return l7 = l7 || [], null == n3 || "boolean" == typeof n3 || (d(n3) ? n3.some(function(n4) {
    H(n4, l7);
  }) : l7.push(n3)), l7;
}
function L(n3, l7, u5, t4) {
  var i5, r4, o4 = n3.key, e4 = n3.type, f5 = l7[u5];
  if (null === f5 || f5 && o4 == f5.key && e4 === f5.type && 0 == (2 & f5.__u)) return u5;
  if (t4 > (null != f5 && 0 == (2 & f5.__u) ? 1 : 0)) for (i5 = u5 - 1, r4 = u5 + 1; i5 >= 0 || r4 < l7.length; ) {
    if (i5 >= 0) {
      if ((f5 = l7[i5]) && 0 == (2 & f5.__u) && o4 == f5.key && e4 === f5.type) return i5;
      i5--;
    }
    if (r4 < l7.length) {
      if ((f5 = l7[r4]) && 0 == (2 & f5.__u) && o4 == f5.key && e4 === f5.type) return r4;
      r4++;
    }
  }
  return -1;
}
function T(n3, l7, u5) {
  "-" == l7[0] ? n3.setProperty(l7, null == u5 ? "" : u5) : n3[l7] = null == u5 ? "" : "number" != typeof u5 || y.test(l7) ? u5 : u5 + "px";
}
function F(n3, l7, u5, t4, i5) {
  var r4;
  n: if ("style" == l7) if ("string" == typeof u5) n3.style.cssText = u5;
  else {
    if ("string" == typeof t4 && (n3.style.cssText = t4 = ""), t4) for (l7 in t4) u5 && l7 in u5 || T(n3.style, l7, "");
    if (u5) for (l7 in u5) t4 && u5[l7] === t4[l7] || T(n3.style, l7, u5[l7]);
  }
  else if ("o" == l7[0] && "n" == l7[1]) r4 = l7 != (l7 = l7.replace(f, "$1")), l7 = l7.toLowerCase() in n3 || "onFocusOut" == l7 || "onFocusIn" == l7 ? l7.toLowerCase().slice(2) : l7.slice(2), n3.l || (n3.l = {}), n3.l[l7 + r4] = u5, u5 ? t4 ? u5.u = t4.u : (u5.u = c, n3.addEventListener(l7, r4 ? a : s, r4)) : n3.removeEventListener(l7, r4 ? a : s, r4);
  else {
    if ("http://www.w3.org/2000/svg" == i5) l7 = l7.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
    else if ("width" != l7 && "height" != l7 && "href" != l7 && "list" != l7 && "form" != l7 && "tabIndex" != l7 && "download" != l7 && "rowSpan" != l7 && "colSpan" != l7 && "role" != l7 && "popover" != l7 && l7 in n3) try {
      n3[l7] = null == u5 ? "" : u5;
      break n;
    } catch (n4) {
    }
    "function" == typeof u5 || (null == u5 || false === u5 && "-" != l7[4] ? n3.removeAttribute(l7) : n3.setAttribute(l7, "popover" == l7 && 1 == u5 ? "" : u5));
  }
}
function O(n3) {
  return function(u5) {
    if (this.l) {
      var t4 = this.l[u5.type + n3];
      if (null == u5.t) u5.t = c++;
      else if (u5.t < t4.u) return;
      return t4(l.event ? l.event(u5) : u5);
    }
  };
}
function j(n3, u5, t4, i5, r4, o4, e4, f5, c4, s5) {
  var a4, h5, p5, v5, y5, g8, m6, b5, C3, S3, M3, P5, I3, A6, H4, L3, T5, F5 = u5.type;
  if (void 0 !== u5.constructor) return null;
  128 & t4.__u && (c4 = !!(32 & t4.__u), o4 = [f5 = u5.__e = t4.__e]), (a4 = l.__b) && a4(u5);
  n: if ("function" == typeof F5) try {
    if (b5 = u5.props, C3 = "prototype" in F5 && F5.prototype.render, S3 = (a4 = F5.contextType) && i5[a4.__c], M3 = a4 ? S3 ? S3.props.value : a4.__ : i5, t4.__c ? m6 = (h5 = u5.__c = t4.__c).__ = h5.__E : (C3 ? u5.__c = h5 = new F5(b5, M3) : (u5.__c = h5 = new x(b5, M3), h5.constructor = F5, h5.render = B), S3 && S3.sub(h5), h5.props = b5, h5.state || (h5.state = {}), h5.context = M3, h5.__n = i5, p5 = h5.__d = true, h5.__h = [], h5._sb = []), C3 && null == h5.__s && (h5.__s = h5.state), C3 && null != F5.getDerivedStateFromProps && (h5.__s == h5.state && (h5.__s = w({}, h5.__s)), w(h5.__s, F5.getDerivedStateFromProps(b5, h5.__s))), v5 = h5.props, y5 = h5.state, h5.__v = u5, p5) C3 && null == F5.getDerivedStateFromProps && null != h5.componentWillMount && h5.componentWillMount(), C3 && null != h5.componentDidMount && h5.__h.push(h5.componentDidMount);
    else {
      if (C3 && null == F5.getDerivedStateFromProps && b5 !== v5 && null != h5.componentWillReceiveProps && h5.componentWillReceiveProps(b5, M3), !h5.__e && (null != h5.shouldComponentUpdate && false === h5.shouldComponentUpdate(b5, h5.__s, M3) || u5.__v == t4.__v)) {
        for (u5.__v != t4.__v && (h5.props = b5, h5.state = h5.__s, h5.__d = false), u5.__e = t4.__e, u5.__k = t4.__k, u5.__k.some(function(n4) {
          n4 && (n4.__ = u5);
        }), P5 = 0; P5 < h5._sb.length; P5++) h5.__h.push(h5._sb[P5]);
        h5._sb = [], h5.__h.length && e4.push(h5);
        break n;
      }
      null != h5.componentWillUpdate && h5.componentWillUpdate(b5, h5.__s, M3), C3 && null != h5.componentDidUpdate && h5.__h.push(function() {
        h5.componentDidUpdate(v5, y5, g8);
      });
    }
    if (h5.context = M3, h5.props = b5, h5.__P = n3, h5.__e = false, I3 = l.__r, A6 = 0, C3) {
      for (h5.state = h5.__s, h5.__d = false, I3 && I3(u5), a4 = h5.render(h5.props, h5.state, h5.context), H4 = 0; H4 < h5._sb.length; H4++) h5.__h.push(h5._sb[H4]);
      h5._sb = [];
    } else do {
      h5.__d = false, I3 && I3(u5), a4 = h5.render(h5.props, h5.state, h5.context), h5.state = h5.__s;
    } while (h5.__d && ++A6 < 25);
    h5.state = h5.__s, null != h5.getChildContext && (i5 = w(w({}, i5), h5.getChildContext())), C3 && !p5 && null != h5.getSnapshotBeforeUpdate && (g8 = h5.getSnapshotBeforeUpdate(v5, y5)), f5 = $(n3, d(L3 = null != a4 && a4.type === k && null == a4.key ? a4.props.children : a4) ? L3 : [L3], u5, t4, i5, r4, o4, e4, f5, c4, s5), h5.base = u5.__e, u5.__u &= -161, h5.__h.length && e4.push(h5), m6 && (h5.__E = h5.__ = null);
  } catch (n4) {
    if (u5.__v = null, c4 || null != o4) if (n4.then) {
      for (u5.__u |= c4 ? 160 : 128; f5 && 8 == f5.nodeType && f5.nextSibling; ) f5 = f5.nextSibling;
      o4[o4.indexOf(f5)] = null, u5.__e = f5;
    } else for (T5 = o4.length; T5--; ) _(o4[T5]);
    else u5.__e = t4.__e, u5.__k = t4.__k;
    l.__e(n4, u5, t4);
  }
  else null == o4 && u5.__v == t4.__v ? (u5.__k = t4.__k, u5.__e = t4.__e) : f5 = u5.__e = N(t4.__e, u5, t4, i5, r4, o4, e4, c4, s5);
  return (a4 = l.diffed) && a4(u5), 128 & u5.__u ? void 0 : f5;
}
function z(n3, u5, t4) {
  for (var i5 = 0; i5 < t4.length; i5++) V(t4[i5], t4[++i5], t4[++i5]);
  l.__c && l.__c(u5, n3), n3.some(function(u6) {
    try {
      n3 = u6.__h, u6.__h = [], n3.some(function(n4) {
        n4.call(u6);
      });
    } catch (n4) {
      l.__e(n4, u6.__v);
    }
  });
}
function N(u5, t4, i5, r4, o4, e4, f5, c4, s5) {
  var a4, h5, v5, y5, w5, g8, m6, b5 = i5.props, k4 = t4.props, x6 = t4.type;
  if ("svg" == x6 ? o4 = "http://www.w3.org/2000/svg" : "math" == x6 ? o4 = "http://www.w3.org/1998/Math/MathML" : o4 || (o4 = "http://www.w3.org/1999/xhtml"), null != e4) {
    for (a4 = 0; a4 < e4.length; a4++) if ((w5 = e4[a4]) && "setAttribute" in w5 == !!x6 && (x6 ? w5.localName == x6 : 3 == w5.nodeType)) {
      u5 = w5, e4[a4] = null;
      break;
    }
  }
  if (null == u5) {
    if (null == x6) return document.createTextNode(k4);
    u5 = document.createElementNS(o4, x6, k4.is && k4), c4 && (l.__m && l.__m(t4, e4), c4 = false), e4 = null;
  }
  if (null === x6) b5 === k4 || c4 && u5.data === k4 || (u5.data = k4);
  else {
    if (e4 = e4 && n.call(u5.childNodes), b5 = i5.props || p, !c4 && null != e4) for (b5 = {}, a4 = 0; a4 < u5.attributes.length; a4++) b5[(w5 = u5.attributes[a4]).name] = w5.value;
    for (a4 in b5) if (w5 = b5[a4], "children" == a4) ;
    else if ("dangerouslySetInnerHTML" == a4) v5 = w5;
    else if (!(a4 in k4)) {
      if ("value" == a4 && "defaultValue" in k4 || "checked" == a4 && "defaultChecked" in k4) continue;
      F(u5, a4, null, w5, o4);
    }
    for (a4 in k4) w5 = k4[a4], "children" == a4 ? y5 = w5 : "dangerouslySetInnerHTML" == a4 ? h5 = w5 : "value" == a4 ? g8 = w5 : "checked" == a4 ? m6 = w5 : c4 && "function" != typeof w5 || b5[a4] === w5 || F(u5, a4, w5, b5[a4], o4);
    if (h5) c4 || v5 && (h5.__html === v5.__html || h5.__html === u5.innerHTML) || (u5.innerHTML = h5.__html), t4.__k = [];
    else if (v5 && (u5.innerHTML = ""), $(u5, d(y5) ? y5 : [y5], t4, i5, r4, "foreignObject" == x6 ? "http://www.w3.org/1999/xhtml" : o4, e4, f5, e4 ? e4[0] : i5.__k && C(i5, 0), c4, s5), null != e4) for (a4 = e4.length; a4--; ) _(e4[a4]);
    c4 || (a4 = "value", "progress" == x6 && null == g8 ? u5.removeAttribute("value") : void 0 !== g8 && (g8 !== u5[a4] || "progress" == x6 && !g8 || "option" == x6 && g8 !== b5[a4]) && F(u5, a4, g8, b5[a4], o4), a4 = "checked", void 0 !== m6 && m6 !== u5[a4] && F(u5, a4, m6, b5[a4], o4));
  }
  return u5;
}
function V(n3, u5, t4) {
  try {
    if ("function" == typeof n3) {
      var i5 = "function" == typeof n3.__u;
      i5 && n3.__u(), i5 && null == u5 || (n3.__u = n3(u5));
    } else n3.current = u5;
  } catch (n4) {
    l.__e(n4, t4);
  }
}
function q(n3, u5, t4) {
  var i5, r4;
  if (l.unmount && l.unmount(n3), (i5 = n3.ref) && (i5.current && i5.current !== n3.__e || V(i5, null, u5)), null != (i5 = n3.__c)) {
    if (i5.componentWillUnmount) try {
      i5.componentWillUnmount();
    } catch (n4) {
      l.__e(n4, u5);
    }
    i5.base = i5.__P = null;
  }
  if (i5 = n3.__k) for (r4 = 0; r4 < i5.length; r4++) i5[r4] && q(i5[r4], u5, t4 || "function" != typeof n3.type);
  t4 || _(n3.__e), n3.__c = n3.__ = n3.__e = void 0;
}
function B(n3, l7, u5) {
  return this.constructor(n3, u5);
}
function D(u5, t4, i5) {
  var r4, o4, e4, f5;
  t4 == document && (t4 = document.documentElement), l.__ && l.__(u5, t4), o4 = (r4 = "function" == typeof i5) ? null : i5 && i5.__k || t4.__k, e4 = [], f5 = [], j(t4, u5 = (!r4 && i5 || t4).__k = g(k, null, [u5]), o4 || p, p, t4.namespaceURI, !r4 && i5 ? [i5] : o4 ? null : t4.firstChild ? n.call(t4.childNodes) : null, e4, !r4 && i5 ? i5 : o4 ? o4.__e : t4.firstChild, r4, f5), z(e4, u5, f5);
}
n = v.slice, l = { __e: function(n3, l7, u5, t4) {
  for (var i5, r4, o4; l7 = l7.__; ) if ((i5 = l7.__c) && !i5.__) try {
    if ((r4 = i5.constructor) && null != r4.getDerivedStateFromError && (i5.setState(r4.getDerivedStateFromError(n3)), o4 = i5.__d), null != i5.componentDidCatch && (i5.componentDidCatch(n3, t4 || {}), o4 = i5.__d), o4) return i5.__E = i5;
  } catch (l8) {
    n3 = l8;
  }
  throw n3;
} }, u = 0, t = function(n3) {
  return null != n3 && null == n3.constructor;
}, x.prototype.setState = function(n3, l7) {
  var u5;
  u5 = null != this.__s && this.__s !== this.state ? this.__s : this.__s = w({}, this.state), "function" == typeof n3 && (n3 = n3(w({}, u5), this.props)), n3 && w(u5, n3), null != n3 && this.__v && (l7 && this._sb.push(l7), M(this));
}, x.prototype.forceUpdate = function(n3) {
  this.__v && (this.__e = true, n3 && this.__h.push(n3), M(this));
}, x.prototype.render = k, i = [], o = "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e = function(n3, l7) {
  return n3.__v.__b - l7.__v.__b;
}, P.__r = 0, f = /(PointerCapture)$|Capture$/i, c = 0, s = O(false), a = O(true), h = 0;

// node_modules/preact/hooks/dist/hooks.module.js
var t2;
var r2;
var u2;
var i2;
var o2 = 0;
var f2 = [];
var c2 = l;
var e2 = c2.__b;
var a2 = c2.__r;
var v2 = c2.diffed;
var l2 = c2.__c;
var m2 = c2.unmount;
var s2 = c2.__;
function d2(n3, t4) {
  c2.__h && c2.__h(r2, n3, o2 || t4), o2 = 0;
  var u5 = r2.__H || (r2.__H = { __: [], __h: [] });
  return n3 >= u5.__.length && u5.__.push({}), u5.__[n3];
}
function h2(n3) {
  return o2 = 1, p2(D2, n3);
}
function p2(n3, u5, i5) {
  var o4 = d2(t2++, 2);
  if (o4.t = n3, !o4.__c && (o4.__ = [i5 ? i5(u5) : D2(void 0, u5), function(n4) {
    var t4 = o4.__N ? o4.__N[0] : o4.__[0], r4 = o4.t(t4, n4);
    t4 !== r4 && (o4.__N = [r4, o4.__[1]], o4.__c.setState({}));
  }], o4.__c = r2, !r2.u)) {
    var f5 = function(n4, t4, r4) {
      if (!o4.__c.__H) return true;
      var u6 = o4.__c.__H.__.filter(function(n5) {
        return !!n5.__c;
      });
      if (u6.every(function(n5) {
        return !n5.__N;
      })) return !c4 || c4.call(this, n4, t4, r4);
      var i6 = o4.__c.props !== n4;
      return u6.forEach(function(n5) {
        if (n5.__N) {
          var t5 = n5.__[0];
          n5.__ = n5.__N, n5.__N = void 0, t5 !== n5.__[0] && (i6 = true);
        }
      }), c4 && c4.call(this, n4, t4, r4) || i6;
    };
    r2.u = true;
    var c4 = r2.shouldComponentUpdate, e4 = r2.componentWillUpdate;
    r2.componentWillUpdate = function(n4, t4, r4) {
      if (this.__e) {
        var u6 = c4;
        c4 = void 0, f5(n4, t4, r4), c4 = u6;
      }
      e4 && e4.call(this, n4, t4, r4);
    }, r2.shouldComponentUpdate = f5;
  }
  return o4.__N || o4.__;
}
function y2(n3, u5) {
  var i5 = d2(t2++, 3);
  !c2.__s && C2(i5.__H, u5) && (i5.__ = n3, i5.i = u5, r2.__H.__h.push(i5));
}
function A2(n3) {
  return o2 = 5, T2(function() {
    return { current: n3 };
  }, []);
}
function T2(n3, r4) {
  var u5 = d2(t2++, 7);
  return C2(u5.__H, r4) && (u5.__ = n3(), u5.__H = r4, u5.__h = n3), u5.__;
}
function q2(n3, t4) {
  return o2 = 8, T2(function() {
    return n3;
  }, t4);
}
function j2() {
  for (var n3; n3 = f2.shift(); ) if (n3.__P && n3.__H) try {
    n3.__H.__h.forEach(z2), n3.__H.__h.forEach(B2), n3.__H.__h = [];
  } catch (t4) {
    n3.__H.__h = [], c2.__e(t4, n3.__v);
  }
}
c2.__b = function(n3) {
  r2 = null, e2 && e2(n3);
}, c2.__ = function(n3, t4) {
  n3 && t4.__k && t4.__k.__m && (n3.__m = t4.__k.__m), s2 && s2(n3, t4);
}, c2.__r = function(n3) {
  a2 && a2(n3), t2 = 0;
  var i5 = (r2 = n3.__c).__H;
  i5 && (u2 === r2 ? (i5.__h = [], r2.__h = [], i5.__.forEach(function(n4) {
    n4.__N && (n4.__ = n4.__N), n4.i = n4.__N = void 0;
  })) : (i5.__h.forEach(z2), i5.__h.forEach(B2), i5.__h = [], t2 = 0)), u2 = r2;
}, c2.diffed = function(n3) {
  v2 && v2(n3);
  var t4 = n3.__c;
  t4 && t4.__H && (t4.__H.__h.length && (1 !== f2.push(t4) && i2 === c2.requestAnimationFrame || ((i2 = c2.requestAnimationFrame) || w2)(j2)), t4.__H.__.forEach(function(n4) {
    n4.i && (n4.__H = n4.i), n4.i = void 0;
  })), u2 = r2 = null;
}, c2.__c = function(n3, t4) {
  t4.some(function(n4) {
    try {
      n4.__h.forEach(z2), n4.__h = n4.__h.filter(function(n5) {
        return !n5.__ || B2(n5);
      });
    } catch (r4) {
      t4.some(function(n5) {
        n5.__h && (n5.__h = []);
      }), t4 = [], c2.__e(r4, n4.__v);
    }
  }), l2 && l2(n3, t4);
}, c2.unmount = function(n3) {
  m2 && m2(n3);
  var t4, r4 = n3.__c;
  r4 && r4.__H && (r4.__H.__.forEach(function(n4) {
    try {
      z2(n4);
    } catch (n5) {
      t4 = n5;
    }
  }), r4.__H = void 0, t4 && c2.__e(t4, r4.__v));
};
var k2 = "function" == typeof requestAnimationFrame;
function w2(n3) {
  var t4, r4 = function() {
    clearTimeout(u5), k2 && cancelAnimationFrame(t4), setTimeout(n3);
  }, u5 = setTimeout(r4, 100);
  k2 && (t4 = requestAnimationFrame(r4));
}
function z2(n3) {
  var t4 = r2, u5 = n3.__c;
  "function" == typeof u5 && (n3.__c = void 0, u5()), r2 = t4;
}
function B2(n3) {
  var t4 = r2;
  n3.__c = n3.__(), r2 = t4;
}
function C2(n3, t4) {
  return !n3 || n3.length !== t4.length || t4.some(function(t5, r4) {
    return t5 !== n3[r4];
  });
}
function D2(n3, t4) {
  return "function" == typeof t4 ? t4(n3) : t4;
}

// node_modules/@preact/signals-core/dist/signals-core.module.js
var i3 = Symbol.for("preact-signals");
function t3() {
  if (!(s3 > 1)) {
    var i5, t4 = false;
    !function() {
      var i6 = c3;
      c3 = void 0;
      while (void 0 !== i6) {
        if (i6.S.v === i6.v) i6.S.i = i6.i;
        i6 = i6.o;
      }
    }();
    while (void 0 !== h3) {
      var n3 = h3;
      h3 = void 0;
      v3++;
      while (void 0 !== n3) {
        var r4 = n3.u;
        n3.u = void 0;
        n3.f &= -3;
        if (!(8 & n3.f) && w3(n3)) try {
          n3.c();
        } catch (n4) {
          if (!t4) {
            i5 = n4;
            t4 = true;
          }
        }
        n3 = r4;
      }
    }
    v3 = 0;
    s3--;
    if (t4) throw i5;
  } else s3--;
}
function n2(i5) {
  if (s3 > 0) return i5();
  e3 = ++u3;
  s3++;
  try {
    return i5();
  } finally {
    t3();
  }
}
var r3 = void 0;
function o3(i5) {
  var t4 = r3;
  r3 = void 0;
  try {
    return i5();
  } finally {
    r3 = t4;
  }
}
var f3;
var h3 = void 0;
var s3 = 0;
var v3 = 0;
var u3 = 0;
var e3 = 0;
var c3 = void 0;
var d3 = 0;
function a3(i5) {
  if (void 0 !== r3) {
    var t4 = i5.n;
    if (void 0 === t4 || t4.t !== r3) {
      t4 = { i: 0, S: i5, p: r3.s, n: void 0, t: r3, e: void 0, x: void 0, r: t4 };
      if (void 0 !== r3.s) r3.s.n = t4;
      r3.s = t4;
      i5.n = t4;
      if (32 & r3.f) i5.S(t4);
      return t4;
    } else if (-1 === t4.i) {
      t4.i = 0;
      if (void 0 !== t4.n) {
        t4.n.p = t4.p;
        if (void 0 !== t4.p) t4.p.n = t4.n;
        t4.p = r3.s;
        t4.n = void 0;
        r3.s.n = t4;
        r3.s = t4;
      }
      return t4;
    }
  }
}
function l3(i5, t4) {
  this.v = i5;
  this.i = 0;
  this.n = void 0;
  this.t = void 0;
  this.l = 0;
  this.W = null == t4 ? void 0 : t4.watched;
  this.Z = null == t4 ? void 0 : t4.unwatched;
  this.name = null == t4 ? void 0 : t4.name;
}
l3.prototype.brand = i3;
l3.prototype.h = function() {
  return true;
};
l3.prototype.S = function(i5) {
  var t4 = this, n3 = this.t;
  if (n3 !== i5 && void 0 === i5.e) {
    i5.x = n3;
    this.t = i5;
    if (void 0 !== n3) n3.e = i5;
    else o3(function() {
      var i6;
      null == (i6 = t4.W) || i6.call(t4);
    });
  }
};
l3.prototype.U = function(i5) {
  var t4 = this;
  if (void 0 !== this.t) {
    var n3 = i5.e, r4 = i5.x;
    if (void 0 !== n3) {
      n3.x = r4;
      i5.e = void 0;
    }
    if (void 0 !== r4) {
      r4.e = n3;
      i5.x = void 0;
    }
    if (i5 === this.t) {
      this.t = r4;
      if (void 0 === r4) o3(function() {
        var i6;
        null == (i6 = t4.Z) || i6.call(t4);
      });
    }
  }
};
l3.prototype.subscribe = function(i5) {
  var t4 = this;
  return j3(function() {
    var n3 = t4.value, o4 = r3;
    r3 = void 0;
    try {
      i5(n3);
    } finally {
      r3 = o4;
    }
  }, { name: "sub" });
};
l3.prototype.valueOf = function() {
  return this.value;
};
l3.prototype.toString = function() {
  return this.value + "";
};
l3.prototype.toJSON = function() {
  return this.value;
};
l3.prototype.peek = function() {
  var i5 = this;
  return o3(function() {
    return i5.value;
  });
};
Object.defineProperty(l3.prototype, "value", { get: function() {
  var i5 = a3(this);
  if (void 0 !== i5) i5.i = this.i;
  return this.v;
}, set: function(i5) {
  if (i5 !== this.v) {
    if (v3 > 100) throw new Error("Cycle detected");
    !function(i6) {
      if (0 !== s3 && 0 === v3) {
        if (i6.l !== e3) {
          i6.l = e3;
          c3 = { S: i6, v: i6.v, i: i6.i, o: c3 };
        }
      }
    }(this);
    this.v = i5;
    this.i++;
    d3++;
    s3++;
    try {
      for (var n3 = this.t; void 0 !== n3; n3 = n3.x) n3.t.N();
    } finally {
      t3();
    }
  }
} });
function y3(i5, t4) {
  return new l3(i5, t4);
}
function w3(i5) {
  for (var t4 = i5.s; void 0 !== t4; t4 = t4.n) if (t4.S.i !== t4.i || !t4.S.h() || t4.S.i !== t4.i) return true;
  return false;
}
function _2(i5) {
  for (var t4 = i5.s; void 0 !== t4; t4 = t4.n) {
    var n3 = t4.S.n;
    if (void 0 !== n3) t4.r = n3;
    t4.S.n = t4;
    t4.i = -1;
    if (void 0 === t4.n) {
      i5.s = t4;
      break;
    }
  }
}
function b(i5) {
  var t4 = i5.s, n3 = void 0;
  while (void 0 !== t4) {
    var r4 = t4.p;
    if (-1 === t4.i) {
      t4.S.U(t4);
      if (void 0 !== r4) r4.n = t4.n;
      if (void 0 !== t4.n) t4.n.p = r4;
    } else n3 = t4;
    t4.S.n = t4.r;
    if (void 0 !== t4.r) t4.r = void 0;
    t4 = r4;
  }
  i5.s = n3;
}
function p3(i5, t4) {
  l3.call(this, void 0);
  this.x = i5;
  this.s = void 0;
  this.g = d3 - 1;
  this.f = 4;
  this.W = null == t4 ? void 0 : t4.watched;
  this.Z = null == t4 ? void 0 : t4.unwatched;
  this.name = null == t4 ? void 0 : t4.name;
}
p3.prototype = new l3();
p3.prototype.h = function() {
  this.f &= -3;
  if (1 & this.f) return false;
  if (32 == (36 & this.f)) return true;
  this.f &= -5;
  if (this.g === d3) return true;
  this.g = d3;
  this.f |= 1;
  if (this.i > 0 && !w3(this)) {
    this.f &= -2;
    return true;
  }
  var i5 = r3;
  try {
    _2(this);
    r3 = this;
    var t4 = this.x();
    if (16 & this.f || this.v !== t4 || 0 === this.i) {
      this.v = t4;
      this.f &= -17;
      this.i++;
    }
  } catch (i6) {
    this.v = i6;
    this.f |= 16;
    this.i++;
  }
  r3 = i5;
  b(this);
  this.f &= -2;
  return true;
};
p3.prototype.S = function(i5) {
  if (void 0 === this.t) {
    this.f |= 36;
    for (var t4 = this.s; void 0 !== t4; t4 = t4.n) t4.S.S(t4);
  }
  l3.prototype.S.call(this, i5);
};
p3.prototype.U = function(i5) {
  if (void 0 !== this.t) {
    l3.prototype.U.call(this, i5);
    if (void 0 === this.t) {
      this.f &= -33;
      for (var t4 = this.s; void 0 !== t4; t4 = t4.n) t4.S.U(t4);
    }
  }
};
p3.prototype.N = function() {
  if (!(2 & this.f)) {
    this.f |= 6;
    for (var i5 = this.t; void 0 !== i5; i5 = i5.x) i5.t.N();
  }
};
Object.defineProperty(p3.prototype, "value", { get: function() {
  if (1 & this.f) throw new Error("Cycle detected");
  var i5 = a3(this);
  this.h();
  if (void 0 !== i5) i5.i = this.i;
  if (16 & this.f) throw this.v;
  return this.v;
} });
function g2(i5, t4) {
  return new p3(i5, t4);
}
function S2(i5) {
  var n3 = i5.m;
  i5.m = void 0;
  if ("function" == typeof n3) {
    s3++;
    var o4 = r3;
    r3 = void 0;
    try {
      n3();
    } catch (t4) {
      i5.f &= -2;
      i5.f |= 8;
      m3(i5);
      throw t4;
    } finally {
      r3 = o4;
      t3();
    }
  }
}
function m3(i5) {
  for (var t4 = i5.s; void 0 !== t4; t4 = t4.n) t4.S.U(t4);
  i5.x = void 0;
  i5.s = void 0;
  S2(i5);
}
function x2(i5) {
  if (r3 !== this) throw new Error("Out-of-order effect");
  b(this);
  r3 = i5;
  this.f &= -2;
  if (8 & this.f) m3(this);
  t3();
}
function E(i5, t4) {
  this.x = i5;
  this.m = void 0;
  this.s = void 0;
  this.u = void 0;
  this.f = 32;
  this.name = null == t4 ? void 0 : t4.name;
  if (f3) f3.push(this);
}
E.prototype.c = function() {
  var i5 = this.S();
  try {
    if (8 & this.f) return;
    if (void 0 === this.x) return;
    var t4 = this.x();
    if ("function" == typeof t4) this.m = t4;
  } finally {
    i5();
  }
};
E.prototype.S = function() {
  if (1 & this.f) throw new Error("Cycle detected");
  this.f |= 1;
  this.f &= -9;
  S2(this);
  _2(this);
  s3++;
  var i5 = r3;
  r3 = this;
  return x2.bind(this, i5);
};
E.prototype.N = function() {
  if (!(2 & this.f)) {
    this.f |= 2;
    this.u = h3;
    h3 = this;
  }
};
E.prototype.d = function() {
  this.f |= 8;
  if (!(1 & this.f)) m3(this);
};
E.prototype.dispose = function() {
  this.d();
};
function j3(i5, t4) {
  var n3 = new E(i5, t4);
  try {
    n3.c();
  } catch (i6) {
    n3.d();
    throw i6;
  }
  var r4 = n3.d.bind(n3);
  r4[Symbol.dispose] = r4;
  return r4;
}

// node_modules/@preact/signals/dist/signals.module.js
var s4;
var h4;
var l4;
var p4 = [];
j3(function() {
  s4 = this.N;
})();
function _3(i5, r4) {
  l[i5] = r4.bind(null, l[i5] || function() {
  });
}
function m4(i5) {
  if (l4) l4();
  l4 = i5 && i5.S();
}
function g3(i5) {
  var n3 = this, f5 = i5.data, o4 = useSignal(f5);
  o4.value = f5;
  var u5 = T2(function() {
    var i6 = n3, t4 = n3.__v;
    while (t4 = t4.__) if (t4.__c) {
      t4.__c.__$f |= 4;
      break;
    }
    var f6 = g2(function() {
      var i7 = o4.value.value;
      return 0 === i7 ? 0 : true === i7 ? "" : i7 || "";
    }), u6 = g2(function() {
      return !t(f6.value);
    }), c5 = j3(function() {
      this.N = A3;
      if (u6.value) {
        var n4 = f6.value;
        if (i6.base && 3 === i6.base.nodeType) i6.base.data = n4;
      }
    }), v6 = n3.__$u.d;
    n3.__$u.d = function() {
      c5();
      v6.call(this);
    };
    return [u6, f6];
  }, []), c4 = u5[0], v5 = u5[1];
  return c4.value ? v5.peek() : v5.value;
}
g3.displayName = "_st";
Object.defineProperties(l3.prototype, { constructor: { configurable: true, value: void 0 }, type: { configurable: true, value: g3 }, props: { configurable: true, get: function() {
  return { data: this };
} }, __b: { configurable: true, value: 1 } });
_3("__b", function(i5, n3) {
  if ("string" == typeof n3.type) {
    var r4, t4 = n3.props;
    for (var f5 in t4) if ("children" !== f5) {
      var o4 = t4[f5];
      if (o4 instanceof l3) {
        if (!r4) n3.__np = r4 = {};
        r4[f5] = o4;
        t4[f5] = o4.peek();
      }
    }
  }
  i5(n3);
});
_3("__r", function(i5, n3) {
  m4();
  var r4, t4 = n3.__c;
  if (t4) {
    t4.__$f &= -2;
    if (void 0 === (r4 = t4.__$u)) t4.__$u = r4 = function(i6) {
      var n4;
      j3(function() {
        n4 = this;
      });
      n4.c = function() {
        t4.__$f |= 1;
        t4.setState({});
      };
      return n4;
    }();
  }
  h4 = t4;
  m4(r4);
  i5(n3);
});
_3("__e", function(i5, n3, r4, t4) {
  m4();
  h4 = void 0;
  i5(n3, r4, t4);
});
_3("diffed", function(i5, n3) {
  m4();
  h4 = void 0;
  var r4;
  if ("string" == typeof n3.type && (r4 = n3.__e)) {
    var t4 = n3.__np, f5 = n3.props;
    if (t4) {
      var o4 = r4.U;
      if (o4) for (var e4 in o4) {
        var u5 = o4[e4];
        if (void 0 !== u5 && !(e4 in t4)) {
          u5.d();
          o4[e4] = void 0;
        }
      }
      else {
        o4 = {};
        r4.U = o4;
      }
      for (var a4 in t4) {
        var c4 = o4[a4], v5 = t4[a4];
        if (void 0 === c4) {
          c4 = b2(r4, a4, v5, f5);
          o4[a4] = c4;
        } else c4.o(v5, f5);
      }
    }
  }
  i5(n3);
});
function b2(i5, n3, r4, t4) {
  var f5 = n3 in i5 && void 0 === i5.ownerSVGElement, o4 = y3(r4);
  return { o: function(i6, n4) {
    o4.value = i6;
    t4 = n4;
  }, d: j3(function() {
    this.N = A3;
    var r5 = o4.value.value;
    if (t4[n3] !== r5) {
      t4[n3] = r5;
      if (f5) i5[n3] = r5;
      else if (r5) i5.setAttribute(n3, r5);
      else i5.removeAttribute(n3);
    }
  }) };
}
_3("unmount", function(i5, n3) {
  if ("string" == typeof n3.type) {
    var r4 = n3.__e;
    if (r4) {
      var t4 = r4.U;
      if (t4) {
        r4.U = void 0;
        for (var f5 in t4) {
          var o4 = t4[f5];
          if (o4) o4.d();
        }
      }
    }
  } else {
    var e4 = n3.__c;
    if (e4) {
      var u5 = e4.__$u;
      if (u5) {
        e4.__$u = void 0;
        u5.d();
      }
    }
  }
  i5(n3);
});
_3("__h", function(i5, n3, r4, t4) {
  if (t4 < 3 || 9 === t4) n3.__$f |= 2;
  i5(n3, r4, t4);
});
x.prototype.shouldComponentUpdate = function(i5, n3) {
  var r4 = this.__$u, t4 = r4 && void 0 !== r4.s;
  for (var f5 in n3) return true;
  if (this.__f || "boolean" == typeof this.u && true === this.u) {
    var o4 = 2 & this.__$f;
    if (!(t4 || o4 || 4 & this.__$f)) return true;
    if (1 & this.__$f) return true;
  } else {
    if (!(t4 || 4 & this.__$f)) return true;
    if (3 & this.__$f) return true;
  }
  for (var e4 in i5) if ("__source" !== e4 && i5[e4] !== this.props[e4]) return true;
  for (var u5 in this.props) if (!(u5 in i5)) return true;
  return false;
};
function useSignal(i5) {
  return T2(function() {
    return y3(i5);
  }, []);
}
var k3 = function(i5) {
  queueMicrotask(function() {
    queueMicrotask(i5);
  });
};
function x3() {
  n2(function() {
    var i5;
    while (i5 = p4.shift()) s4.call(i5);
  });
}
function A3() {
  if (1 === p4.push(this)) (l.requestAnimationFrame || k3)(x3);
}

// src/api.ts
async function api(url, opts) {
  const r4 = await fetch(url, { credentials: "same-origin", ...opts });
  if (r4.status === 401) {
    const next = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
    window.location.replace(`/ui/login?next=${next}`);
    throw new Error("unauthorized");
  }
  if (!r4.ok) throw new Error("HTTP " + r4.status);
  return r4.json();
}
async function postJson(path, body) {
  const r4 = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try {
    data = await r4.json();
  } catch {
  }
  return { ok: r4.ok, status: r4.status, data };
}

// src/state.ts
var groups = y3([]);
var groupId = y3(null);
var isAdmin = g2(() => {
  const id = groupId.value;
  if (!id) return false;
  const g8 = groups.value.find((x6) => x6.id === id);
  return !!(g8 && g8.isAdmin);
});
if (typeof document !== "undefined") {
  j3(() => {
    document.body.classList.toggle("is-admin", isAdmin.value);
  });
}
var isElevatedUser = y3(false);
var treePath = y3("");
var filePath = y3(null);
var treeEntries = y3([]);
var treeError = y3("");
var mediaCurrentTime = y3(0);
var threads = y3([]);
var threadId = y3(null);
var channelType = y3("web");
var messagingGroupId = y3(null);
var canSend = y3(true);
var voiceMode = y3("off");
var chatMessages = y3([]);
var chatStatus = y3("");
var chatLoading = y3(false);
var isTyping = y3(false);
var typingHint = y3("");
var activityLog = y3([]);
var pending = y3([]);
var searchQuery = y3("");
var searchResults = y3(null);
var searchLoading = y3(false);
var searchOpen = y3(false);
var highlightMessageId = y3(null);
var scrollToBottomTick = y3(0);
var paneOpen = {
  threads: y3(false),
  files: y3(false)
};
var drawerOpen = {
  threads: y3(false),
  files: y3(false)
};
var isMobile = y3(false);
var uploadItems = y3([]);
var me = y3("");
var notifMutedSig = y3(false);
var progressSoundMutedSig = y3(false);
var completionSoundMutedSig = y3(false);
var settingsOpen = y3(false);
var groupAdminOpen = y3(false);
var groupPickerOpen = y3(false);
var groupPickerMode = y3("all");
var shareModalRequest = y3(null);
var toastMessage = y3(null);
var previewBlock = y3(null);
var nowTick = y3(Date.now());
var pinnedContext = y3([]);
var pendingApprovals = y3([]);
var respondingApprovalIds = y3(/* @__PURE__ */ new Set());
var pendingQuestions = y3([]);
var respondingQuestionIds = y3(/* @__PURE__ */ new Set());
var refs = {
  ws: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  syncTimer: null,
  wsPingTimer: null,
  seenIds: /* @__PURE__ */ new Set(),
  suppressHashCount: 0,
  uploadDragDepth: 0,
  newChatInFlight: false,
  carryActivity: []
};
var SYNC_INTERVAL_MS = 1e4;
var UPLOAD_MAX_FILE_SIZE = 25 * 1024 * 1024;
var UPLOAD_MAX_TOTAL_SIZE = 50 * 1024 * 1024;
var UPLOAD_MAX_FILES = 10;
var MOBILE_MQ = window.matchMedia("(max-width: 720px)");
var NOTIF_MUTE_KEY = "nanoclaw:notif:muted";
var PROGRESS_SOUND_KEY = "nanoclaw:sound:progress:muted";
var COMPLETION_SOUND_KEY = "nanoclaw:sound:completion:muted";
var CHANNEL_META = {
  web: { label: "Web", icon: "\u{1F4AC}" },
  resend: { label: "Email", icon: "\u{1F4E7}" },
  discord: { label: "Discord", icon: "\u{1F47E}" },
  telegram: { label: "Telegram", icon: "\u2708\uFE0F" },
  whatsapp: { label: "WhatsApp", icon: "\u{1F4DE}" },
  imessage: { label: "iMessage", icon: "\u{1F4AC}" },
  signal: { label: "Signal", icon: "\u{1F512}" },
  slack: { label: "Slack", icon: "#" },
  matrix: { label: "Matrix", icon: "M" },
  gchat: { label: "Chat", icon: "G" }
};
function channelMeta(ct) {
  return ct && CHANNEL_META[ct] || { label: ct || "Channel", icon: "\u2022" };
}

// src/brand.ts
var g4 = globalThis.__BRAND__ ?? {};
var BRAND = {
  name: g4.name || "NanoClaw",
  shortName: g4.shortName || g4.name || "NanoClaw",
  description: g4.description || "",
  themeColor: g4.themeColor || "#0d1117",
  backgroundColor: g4.backgroundColor || "#0d1117"
};

// src/hash.ts
var import_path_to_regexp = __toESM(require_dist(), 1);

// node_modules/marked/lib/marked.esm.js
function M2() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var T3 = M2();
function N2(l7) {
  T3 = l7;
}
var _4 = { exec: () => null };
function E2(l7) {
  let e4 = [];
  return (t4) => {
    let n3 = Math.max(0, Math.min(3, t4 - 1)), s5 = e4[n3];
    return s5 || (s5 = l7(n3), e4[n3] = s5), s5;
  };
}
function d4(l7, e4 = "") {
  let t4 = typeof l7 == "string" ? l7 : l7.source, n3 = { replace: (s5, r4) => {
    let i5 = typeof r4 == "string" ? r4 : r4.source;
    return i5 = i5.replace(m5.caret, "$1"), t4 = t4.replace(s5, i5), n3;
  }, getRegex: () => new RegExp(t4, e4) };
  return n3;
}
var Te = ((l7 = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + l7);
  } catch {
    return false;
  }
})();
var m5 = { codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (l7) => new RegExp(`^( {0,3}${l7})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: E2((l7) => new RegExp(`^ {0,${l7}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: E2((l7) => new RegExp(`^ {0,${l7}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`)), fencesBeginRegex: E2((l7) => new RegExp(`^ {0,${l7}}(?:\`\`\`|~~~)`)), headingBeginRegex: E2((l7) => new RegExp(`^ {0,${l7}}#`)), htmlBeginRegex: E2((l7) => new RegExp(`^ {0,${l7}}<(?:[a-z].*>|!--)`, "i")), blockquoteBeginRegex: E2((l7) => new RegExp(`^ {0,${l7}}>`)) };
var Oe = /^(?:[ \t]*(?:\n|$))+/;
var we = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var ye = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
var B3 = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var Pe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var j4 = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var oe = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
var ae = d4(oe).replace(/bull/g, j4).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
var Se = d4(oe).replace(/bull/g, j4).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
var F2 = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/;
var $e = /^[^\n]+/;
var U = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
var Le = d4(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", U).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
var _e = d4(/^(bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g, j4).getRegex();
var H2 = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var K = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var ze = d4("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", K).replace("tag", H2).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
var le = d4(F2).replace("hr", B3).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H2).getRegex();
var Me = d4(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", le).getRegex();
var W = { blockquote: Me, code: we, def: Le, fences: ye, heading: Pe, hr: B3, html: ze, lheading: ae, list: _e, newline: Oe, paragraph: le, table: _4, text: $e };
var se = d4("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", B3).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H2).getRegex();
var Ee = { ...W, lheading: Se, table: se, paragraph: d4(F2).replace("hr", B3).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", se).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H2).getRegex() };
var Ie = { ...W, html: d4(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", K).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: _4, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: d4(F2).replace("hr", B3).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", ae).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
var Ae = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var Ce = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var ue = /^( {2,}|\\)\n(?!\s*$)/;
var Be = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var I2 = /[\p{P}\p{S}]/u;
var Z = /[\s\p{P}\p{S}]/u;
var X = /[^\s\p{P}\p{S}]/u;
var De = d4(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, Z).getRegex();
var pe = /(?!~)[\p{P}\p{S}]/u;
var qe = /(?!~)[\s\p{P}\p{S}]/u;
var ve = /(?:[^\s\p{P}\p{S}]|~)/u;
var He = d4(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", Te ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
var ce = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var Ze = d4(ce, "u").replace(/punct/g, I2).getRegex();
var Ge = d4(ce, "u").replace(/punct/g, pe).getRegex();
var he = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var Ne = d4(he, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I2).getRegex();
var Qe = d4(he, "gu").replace(/notPunctSpace/g, ve).replace(/punctSpace/g, qe).replace(/punct/g, pe).getRegex();
var je = d4("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I2).getRegex();
var Fe = d4(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, I2).getRegex();
var Ue = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var Ke = d4(Ue, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I2).getRegex();
var We = d4(/\\(punct)/, "gu").replace(/punct/g, I2).getRegex();
var Xe = d4(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
var Je = d4(K).replace("(?:-->|$)", "-->").getRegex();
var Ve = d4("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", Je).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
var v4 = /(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
var Ye = d4(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label", v4).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
var ke = d4(/^!?\[(label)\]\[(ref)\]/).replace("label", v4).replace("ref", U).getRegex();
var de = d4(/^!?\[(ref)\](?:\[\])?/).replace("ref", U).getRegex();
var et = d4("reflink|nolink(?!\\()", "g").replace("reflink", ke).replace("nolink", de).getRegex();
var ie = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var J = { _backpedal: _4, anyPunctuation: We, autolink: Xe, blockSkip: He, br: ue, code: Ce, del: _4, delLDelim: _4, delRDelim: _4, emStrongLDelim: Ze, emStrongRDelimAst: Ne, emStrongRDelimUnd: je, escape: Ae, link: Ye, nolink: de, punctuation: De, reflink: ke, reflinkSearch: et, tag: Ve, text: Be, url: _4 };
var tt = { ...J, link: d4(/^!?\[(label)\]\((.*?)\)/).replace("label", v4).getRegex(), reflink: d4(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", v4).getRegex() };
var Q = { ...J, emStrongRDelimAst: Qe, emStrongLDelim: Ge, delLDelim: Fe, delRDelim: Ke, url: d4(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol", ie).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: d4(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol", ie).getRegex() };
var nt = { ...Q, br: d4(ue).replace("{2,}", "*").getRegex(), text: d4(Q.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
var D3 = { normal: W, gfm: Ee, pedantic: Ie };
var A4 = { normal: J, gfm: Q, breaks: nt, pedantic: tt };
var rt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var ge = (l7) => rt[l7];
function O2(l7, e4) {
  if (e4) {
    if (m5.escapeTest.test(l7)) return l7.replace(m5.escapeReplace, ge);
  } else if (m5.escapeTestNoEncode.test(l7)) return l7.replace(m5.escapeReplaceNoEncode, ge);
  return l7;
}
function V2(l7) {
  try {
    l7 = encodeURI(l7).replace(m5.percentDecode, "%");
  } catch {
    return null;
  }
  return l7;
}
function Y(l7, e4) {
  let t4 = l7.replace(m5.findPipe, (r4, i5, o4) => {
    let u5 = false, a4 = i5;
    for (; --a4 >= 0 && o4[a4] === "\\"; ) u5 = !u5;
    return u5 ? "|" : " |";
  }), n3 = t4.split(m5.splitPipe), s5 = 0;
  if (n3[0].trim() || n3.shift(), n3.length > 0 && !n3.at(-1)?.trim() && n3.pop(), e4) if (n3.length > e4) n3.splice(e4);
  else for (; n3.length < e4; ) n3.push("");
  for (; s5 < n3.length; s5++) n3[s5] = n3[s5].trim().replace(m5.slashPipe, "|");
  return n3;
}
function $2(l7, e4, t4) {
  let n3 = l7.length;
  if (n3 === 0) return "";
  let s5 = 0;
  for (; s5 < n3; ) {
    let r4 = l7.charAt(n3 - s5 - 1);
    if (r4 === e4 && !t4) s5++;
    else if (r4 !== e4 && t4) s5++;
    else break;
  }
  return l7.slice(0, n3 - s5);
}
function ee(l7) {
  let e4 = l7.split(`
`), t4 = e4.length - 1;
  for (; t4 >= 0 && m5.blankLine.test(e4[t4]); ) t4--;
  return e4.length - t4 <= 2 ? l7 : e4.slice(0, t4 + 1).join(`
`);
}
function fe(l7, e4) {
  if (l7.indexOf(e4[1]) === -1) return -1;
  let t4 = 0;
  for (let n3 = 0; n3 < l7.length; n3++) if (l7[n3] === "\\") n3++;
  else if (l7[n3] === e4[0]) t4++;
  else if (l7[n3] === e4[1] && (t4--, t4 < 0)) return n3;
  return t4 > 0 ? -2 : -1;
}
function me2(l7, e4 = 0) {
  let t4 = e4, n3 = "";
  for (let s5 of l7) if (s5 === "	") {
    let r4 = 4 - t4 % 4;
    n3 += " ".repeat(r4), t4 += r4;
  } else n3 += s5, t4++;
  return n3;
}
function xe(l7, e4, t4, n3, s5) {
  let r4 = e4.href, i5 = e4.title || null, o4 = l7[1].replace(s5.other.outputLinkReplace, "$1");
  n3.state.inLink = true;
  let u5 = { type: l7[0].charAt(0) === "!" ? "image" : "link", raw: t4, href: r4, title: i5, text: o4, tokens: n3.inlineTokens(o4) };
  return n3.state.inLink = false, u5;
}
function st(l7, e4, t4) {
  let n3 = l7.match(t4.other.indentCodeCompensation);
  if (n3 === null) return e4;
  let s5 = n3[1];
  return e4.split(`
`).map((r4) => {
    let i5 = r4.match(t4.other.beginningSpace);
    if (i5 === null) return r4;
    let [o4] = i5;
    return o4.length >= s5.length ? r4.slice(s5.length) : r4;
  }).join(`
`);
}
var w4 = class {
  options;
  rules;
  lexer;
  constructor(e4) {
    this.options = e4 || T3;
  }
  space(e4) {
    let t4 = this.rules.block.newline.exec(e4);
    if (t4 && t4[0].length > 0) return { type: "space", raw: t4[0] };
  }
  code(e4) {
    let t4 = this.rules.block.code.exec(e4);
    if (t4) {
      let n3 = this.options.pedantic ? t4[0] : ee(t4[0]), s5 = n3.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: n3, codeBlockStyle: "indented", text: s5 };
    }
  }
  fences(e4) {
    let t4 = this.rules.block.fences.exec(e4);
    if (t4) {
      let n3 = t4[0], s5 = st(n3, t4[3] || "", this.rules);
      return { type: "code", raw: n3, lang: t4[2] ? t4[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t4[2], text: s5 };
    }
  }
  heading(e4) {
    let t4 = this.rules.block.heading.exec(e4);
    if (t4) {
      let n3 = t4[2].trim();
      if (this.rules.other.endingHash.test(n3)) {
        let s5 = $2(n3, "#");
        (this.options.pedantic || !s5 || this.rules.other.endingSpaceChar.test(s5)) && (n3 = s5.trim());
      }
      return { type: "heading", raw: $2(t4[0], `
`), depth: t4[1].length, text: n3, tokens: this.lexer.inline(n3) };
    }
  }
  hr(e4) {
    let t4 = this.rules.block.hr.exec(e4);
    if (t4) return { type: "hr", raw: $2(t4[0], `
`) };
  }
  blockquote(e4) {
    let t4 = this.rules.block.blockquote.exec(e4);
    if (t4) {
      let n3 = $2(t4[0], `
`).split(`
`), s5 = "", r4 = "", i5 = [];
      for (; n3.length > 0; ) {
        let o4 = false, u5 = [], a4;
        for (a4 = 0; a4 < n3.length; a4++) if (this.rules.other.blockquoteStart.test(n3[a4])) u5.push(n3[a4]), o4 = true;
        else if (!o4) u5.push(n3[a4]);
        else break;
        n3 = n3.slice(a4);
        let c4 = u5.join(`
`), p5 = c4.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        s5 = s5 ? `${s5}
${c4}` : c4, r4 = r4 ? `${r4}
${p5}` : p5;
        let k4 = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(p5, i5, true), this.lexer.state.top = k4, n3.length === 0) break;
        let h5 = i5.at(-1);
        if (h5?.type === "code") break;
        if (h5?.type === "blockquote") {
          let R = h5, f5 = R.raw + `
` + n3.join(`
`), S3 = this.blockquote(f5);
          i5[i5.length - 1] = S3, s5 = s5.substring(0, s5.length - R.raw.length) + S3.raw, r4 = r4.substring(0, r4.length - R.text.length) + S3.text;
          break;
        } else if (h5?.type === "list") {
          let R = h5, f5 = R.raw + `
` + n3.join(`
`), S3 = this.list(f5);
          i5[i5.length - 1] = S3, s5 = s5.substring(0, s5.length - h5.raw.length) + S3.raw, r4 = r4.substring(0, r4.length - R.raw.length) + S3.raw, n3 = f5.substring(i5.at(-1).raw.length).split(`
`);
          continue;
        }
      }
      return { type: "blockquote", raw: s5, tokens: i5, text: r4 };
    }
  }
  list(e4) {
    let t4 = this.rules.block.list.exec(e4);
    if (t4) {
      let n3 = t4[1].trim(), s5 = n3.length > 1, r4 = { type: "list", raw: "", ordered: s5, start: s5 ? +n3.slice(0, -1) : "", loose: false, items: [] };
      n3 = s5 ? `\\d{1,9}\\${n3.slice(-1)}` : `\\${n3}`, this.options.pedantic && (n3 = s5 ? n3 : "[*+-]");
      let i5 = this.rules.other.listItemRegex(n3), o4 = false;
      for (; e4; ) {
        let a4 = false, c4 = "", p5 = "";
        if (!(t4 = i5.exec(e4)) || this.rules.block.hr.test(e4)) break;
        c4 = t4[0], e4 = e4.substring(c4.length);
        let k4 = me2(t4[2].split(`
`, 1)[0], t4[1].length), h5 = e4.split(`
`, 1)[0], R = !k4.trim(), f5 = 0;
        if (this.options.pedantic ? (f5 = 2, p5 = k4.trimStart()) : R ? f5 = t4[1].length + 1 : (f5 = k4.search(this.rules.other.nonSpaceChar), f5 = f5 > 4 ? 1 : f5, p5 = k4.slice(f5), f5 += t4[1].length), R && this.rules.other.blankLine.test(h5) && (c4 += h5 + `
`, e4 = e4.substring(h5.length + 1), a4 = true), !a4) {
          let S3 = this.rules.other.nextBulletRegex(f5), te = this.rules.other.hrRegex(f5), ne = this.rules.other.fencesBeginRegex(f5), re = this.rules.other.headingBeginRegex(f5), be = this.rules.other.htmlBeginRegex(f5), Re = this.rules.other.blockquoteBeginRegex(f5);
          for (; e4; ) {
            let G3 = e4.split(`
`, 1)[0], C3;
            if (h5 = G3, this.options.pedantic ? (h5 = h5.replace(this.rules.other.listReplaceNesting, "  "), C3 = h5) : C3 = h5.replace(this.rules.other.tabCharGlobal, "    "), ne.test(h5) || re.test(h5) || be.test(h5) || Re.test(h5) || S3.test(h5) || te.test(h5)) break;
            if (C3.search(this.rules.other.nonSpaceChar) >= f5 || !h5.trim()) p5 += `
` + C3.slice(f5);
            else {
              if (R || k4.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || ne.test(k4) || re.test(k4) || te.test(k4)) break;
              p5 += `
` + h5;
            }
            R = !h5.trim(), c4 += G3 + `
`, e4 = e4.substring(G3.length + 1), k4 = C3.slice(f5);
          }
        }
        r4.loose || (o4 ? r4.loose = true : this.rules.other.doubleBlankLine.test(c4) && (o4 = true)), r4.items.push({ type: "list_item", raw: c4, task: !!this.options.gfm && this.rules.other.listIsTask.test(p5), loose: false, text: p5, tokens: [] }), r4.raw += c4;
      }
      let u5 = r4.items.at(-1);
      if (u5) u5.raw = u5.raw.trimEnd(), u5.text = u5.text.trimEnd();
      else return;
      r4.raw = r4.raw.trimEnd();
      for (let a4 of r4.items) {
        this.lexer.state.top = false, a4.tokens = this.lexer.blockTokens(a4.text, []);
        let c4 = a4.tokens[0];
        if (a4.task && (c4?.type === "text" || c4?.type === "paragraph")) {
          a4.text = a4.text.replace(this.rules.other.listReplaceTask, ""), c4.raw = c4.raw.replace(this.rules.other.listReplaceTask, ""), c4.text = c4.text.replace(this.rules.other.listReplaceTask, "");
          for (let k4 = this.lexer.inlineQueue.length - 1; k4 >= 0; k4--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[k4].src)) {
            this.lexer.inlineQueue[k4].src = this.lexer.inlineQueue[k4].src.replace(this.rules.other.listReplaceTask, "");
            break;
          }
          let p5 = this.rules.other.listTaskCheckbox.exec(a4.raw);
          if (p5) {
            let k4 = { type: "checkbox", raw: p5[0] + " ", checked: p5[0] !== "[ ]" };
            a4.checked = k4.checked, r4.loose ? a4.tokens[0] && ["paragraph", "text"].includes(a4.tokens[0].type) && "tokens" in a4.tokens[0] && a4.tokens[0].tokens ? (a4.tokens[0].raw = k4.raw + a4.tokens[0].raw, a4.tokens[0].text = k4.raw + a4.tokens[0].text, a4.tokens[0].tokens.unshift(k4)) : a4.tokens.unshift({ type: "paragraph", raw: k4.raw, text: k4.raw, tokens: [k4] }) : a4.tokens.unshift(k4);
          }
        } else a4.task && (a4.task = false);
        if (!r4.loose) {
          let p5 = a4.tokens.filter((h5) => h5.type === "space"), k4 = p5.length > 0 && p5.some((h5) => this.rules.other.anyLine.test(h5.raw));
          r4.loose = k4;
        }
      }
      if (r4.loose) for (let a4 of r4.items) {
        a4.loose = true;
        for (let c4 of a4.tokens) c4.type === "text" && (c4.type = "paragraph");
      }
      return r4;
    }
  }
  html(e4) {
    let t4 = this.rules.block.html.exec(e4);
    if (t4) {
      let n3 = ee(t4[0]);
      return { type: "html", block: true, raw: n3, pre: t4[1] === "pre" || t4[1] === "script" || t4[1] === "style", text: n3 };
    }
  }
  def(e4) {
    let t4 = this.rules.block.def.exec(e4);
    if (t4) {
      let n3 = t4[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal, " "), s5 = t4[2] ? t4[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r4 = t4[3] ? t4[3].substring(1, t4[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t4[3];
      return { type: "def", tag: n3, raw: $2(t4[0], `
`), href: s5, title: r4 };
    }
  }
  table(e4) {
    let t4 = this.rules.block.table.exec(e4);
    if (!t4 || !this.rules.other.tableDelimiter.test(t4[2])) return;
    let n3 = Y(t4[1]), s5 = t4[2].replace(this.rules.other.tableAlignChars, "").split("|"), r4 = t4[3]?.trim() ? t4[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], i5 = { type: "table", raw: $2(t4[0], `
`), header: [], align: [], rows: [] };
    if (n3.length === s5.length) {
      for (let o4 of s5) this.rules.other.tableAlignRight.test(o4) ? i5.align.push("right") : this.rules.other.tableAlignCenter.test(o4) ? i5.align.push("center") : this.rules.other.tableAlignLeft.test(o4) ? i5.align.push("left") : i5.align.push(null);
      for (let o4 = 0; o4 < n3.length; o4++) i5.header.push({ text: n3[o4], tokens: this.lexer.inline(n3[o4]), header: true, align: i5.align[o4] });
      for (let o4 of r4) i5.rows.push(Y(o4, i5.header.length).map((u5, a4) => ({ text: u5, tokens: this.lexer.inline(u5), header: false, align: i5.align[a4] })));
      return i5;
    }
  }
  lheading(e4) {
    let t4 = this.rules.block.lheading.exec(e4);
    if (t4) {
      let n3 = t4[1].trim();
      return { type: "heading", raw: $2(t4[0], `
`), depth: t4[2].charAt(0) === "=" ? 1 : 2, text: n3, tokens: this.lexer.inline(n3) };
    }
  }
  paragraph(e4) {
    let t4 = this.rules.block.paragraph.exec(e4);
    if (t4) {
      let n3 = t4[1].charAt(t4[1].length - 1) === `
` ? t4[1].slice(0, -1) : t4[1];
      return { type: "paragraph", raw: t4[0], text: n3, tokens: this.lexer.inline(n3) };
    }
  }
  text(e4) {
    let t4 = this.rules.block.text.exec(e4);
    if (t4) return { type: "text", raw: t4[0], text: t4[0], tokens: this.lexer.inline(t4[0]) };
  }
  escape(e4) {
    let t4 = this.rules.inline.escape.exec(e4);
    if (t4) return { type: "escape", raw: t4[0], text: t4[1] };
  }
  tag(e4) {
    let t4 = this.rules.inline.tag.exec(e4);
    if (t4) return !this.lexer.state.inLink && this.rules.other.startATag.test(t4[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t4[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t4[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t4[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t4[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t4[0] };
  }
  link(e4) {
    let t4 = this.rules.inline.link.exec(e4);
    if (t4) {
      let n3 = t4[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(n3)) {
        if (!this.rules.other.endAngleBracket.test(n3)) return;
        let i5 = $2(n3.slice(0, -1), "\\");
        if ((n3.length - i5.length) % 2 === 0) return;
      } else {
        let i5 = fe(t4[2], "()");
        if (i5 === -2) return;
        if (i5 > -1) {
          let u5 = (t4[0].indexOf("!") === 0 ? 5 : 4) + t4[1].length + i5;
          t4[2] = t4[2].substring(0, i5), t4[0] = t4[0].substring(0, u5).trim(), t4[3] = "";
        }
      }
      let s5 = t4[2], r4 = "";
      if (this.options.pedantic) {
        let i5 = this.rules.other.pedanticHrefTitle.exec(s5);
        i5 && (s5 = i5[1], r4 = i5[3]);
      } else r4 = t4[3] ? t4[3].slice(1, -1) : "";
      return s5 = s5.trim(), this.rules.other.startAngleBracket.test(s5) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(n3) ? s5 = s5.slice(1) : s5 = s5.slice(1, -1)), xe(t4, { href: s5 && s5.replace(this.rules.inline.anyPunctuation, "$1"), title: r4 && r4.replace(this.rules.inline.anyPunctuation, "$1") }, t4[0], this.lexer, this.rules);
    }
  }
  reflink(e4, t4) {
    let n3;
    if ((n3 = this.rules.inline.reflink.exec(e4)) || (n3 = this.rules.inline.nolink.exec(e4))) {
      let s5 = (n3[2] || n3[1]).replace(this.rules.other.multipleSpaceGlobal, " "), r4 = t4[s5.toLowerCase()];
      if (!r4) {
        let i5 = n3[0].charAt(0);
        return { type: "text", raw: i5, text: i5 };
      }
      return xe(n3, r4, n3[0], this.lexer, this.rules);
    }
  }
  emStrong(e4, t4, n3 = "") {
    let s5 = this.rules.inline.emStrongLDelim.exec(e4);
    if (!s5 || !s5[1] && !s5[2] && !s5[3] && !s5[4] || s5[4] && n3.match(this.rules.other.unicodeAlphaNumeric)) return;
    if (!(s5[1] || s5[3] || "") || !n3 || this.rules.inline.punctuation.exec(n3)) {
      let i5 = [...s5[0]].length - 1, o4, u5, a4 = i5, c4 = 0, p5 = s5[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      for (p5.lastIndex = 0, t4 = t4.slice(-1 * e4.length + i5); (s5 = p5.exec(t4)) !== null; ) {
        if (o4 = s5[1] || s5[2] || s5[3] || s5[4] || s5[5] || s5[6], !o4) continue;
        if (u5 = [...o4].length, s5[3] || s5[4]) {
          a4 += u5;
          continue;
        } else if ((s5[5] || s5[6]) && i5 % 3 && !((i5 + u5) % 3)) {
          c4 += u5;
          continue;
        }
        if (a4 -= u5, a4 > 0) continue;
        u5 = Math.min(u5, u5 + a4 + c4);
        let k4 = [...s5[0]][0].length, h5 = e4.slice(0, i5 + s5.index + k4 + u5);
        if (Math.min(i5, u5) % 2) {
          let f5 = h5.slice(1, -1);
          return { type: "em", raw: h5, text: f5, tokens: this.lexer.inlineTokens(f5) };
        }
        let R = h5.slice(2, -2);
        return { type: "strong", raw: h5, text: R, tokens: this.lexer.inlineTokens(R) };
      }
    }
  }
  codespan(e4) {
    let t4 = this.rules.inline.code.exec(e4);
    if (t4) {
      let n3 = t4[2].replace(this.rules.other.newLineCharGlobal, " "), s5 = this.rules.other.nonSpaceChar.test(n3), r4 = this.rules.other.startingSpaceChar.test(n3) && this.rules.other.endingSpaceChar.test(n3);
      return s5 && r4 && (n3 = n3.substring(1, n3.length - 1)), { type: "codespan", raw: t4[0], text: n3 };
    }
  }
  br(e4) {
    let t4 = this.rules.inline.br.exec(e4);
    if (t4) return { type: "br", raw: t4[0] };
  }
  del(e4, t4, n3 = "") {
    let s5 = this.rules.inline.delLDelim.exec(e4);
    if (!s5) return;
    if (!(s5[1] || "") || !n3 || this.rules.inline.punctuation.exec(n3)) {
      let i5 = [...s5[0]].length - 1, o4, u5, a4 = i5, c4 = this.rules.inline.delRDelim;
      for (c4.lastIndex = 0, t4 = t4.slice(-1 * e4.length + i5); (s5 = c4.exec(t4)) !== null; ) {
        if (o4 = s5[1] || s5[2] || s5[3] || s5[4] || s5[5] || s5[6], !o4 || (u5 = [...o4].length, u5 !== i5)) continue;
        if (s5[3] || s5[4]) {
          a4 += u5;
          continue;
        }
        if (a4 -= u5, a4 > 0) continue;
        u5 = Math.min(u5, u5 + a4);
        let p5 = [...s5[0]][0].length, k4 = e4.slice(0, i5 + s5.index + p5 + u5), h5 = k4.slice(i5, -i5);
        return { type: "del", raw: k4, text: h5, tokens: this.lexer.inlineTokens(h5) };
      }
    }
  }
  autolink(e4) {
    let t4 = this.rules.inline.autolink.exec(e4);
    if (t4) {
      let n3, s5;
      return t4[2] === "@" ? (n3 = t4[1], s5 = "mailto:" + n3) : (n3 = t4[1], s5 = n3), { type: "link", raw: t4[0], text: n3, href: s5, tokens: [{ type: "text", raw: n3, text: n3 }] };
    }
  }
  url(e4) {
    let t4;
    if (t4 = this.rules.inline.url.exec(e4)) {
      let n3, s5;
      if (t4[2] === "@") n3 = t4[0], s5 = "mailto:" + n3;
      else {
        let r4;
        do
          r4 = t4[0], t4[0] = this.rules.inline._backpedal.exec(t4[0])?.[0] ?? "";
        while (r4 !== t4[0]);
        n3 = t4[0], t4[1] === "www." ? s5 = "http://" + t4[0] : s5 = t4[0];
      }
      return { type: "link", raw: t4[0], text: n3, href: s5, tokens: [{ type: "text", raw: n3, text: n3 }] };
    }
  }
  inlineText(e4) {
    let t4 = this.rules.inline.text.exec(e4);
    if (t4) {
      let n3 = this.lexer.state.inRawBlock;
      return { type: "text", raw: t4[0], text: t4[0], escaped: n3 };
    }
  }
};
var x4 = class l5 {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e4) {
    this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e4 || T3, this.options.tokenizer = this.options.tokenizer || new w4(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, top: true };
    let t4 = { other: m5, block: D3.normal, inline: A4.normal };
    this.options.pedantic ? (t4.block = D3.pedantic, t4.inline = A4.pedantic) : this.options.gfm && (t4.block = D3.gfm, this.options.breaks ? t4.inline = A4.breaks : t4.inline = A4.gfm), this.tokenizer.rules = t4;
  }
  static get rules() {
    return { block: D3, inline: A4 };
  }
  static lex(e4, t4) {
    return new l5(t4).lex(e4);
  }
  static lexInline(e4, t4) {
    return new l5(t4).inlineTokens(e4);
  }
  lex(e4) {
    e4 = e4.replace(m5.carriageReturn, `
`), this.blockTokens(e4, this.tokens);
    for (let t4 = 0; t4 < this.inlineQueue.length; t4++) {
      let n3 = this.inlineQueue[t4];
      this.inlineTokens(n3.src, n3.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e4, t4 = [], n3 = false) {
    this.tokenizer.lexer = this, this.options.pedantic && (e4 = e4.replace(m5.tabCharGlobal, "    ").replace(m5.spaceLine, ""));
    let s5 = 1 / 0;
    for (; e4; ) {
      if (e4.length < s5) s5 = e4.length;
      else {
        this.infiniteLoopError(e4.charCodeAt(0));
        break;
      }
      let r4;
      if (this.options.extensions?.block?.some((o4) => (r4 = o4.call({ lexer: this }, e4, t4)) ? (e4 = e4.substring(r4.raw.length), t4.push(r4), true) : false)) continue;
      if (r4 = this.tokenizer.space(e4)) {
        e4 = e4.substring(r4.raw.length);
        let o4 = t4.at(-1);
        r4.raw.length === 1 && o4 !== void 0 ? o4.raw += `
` : t4.push(r4);
        continue;
      }
      if (r4 = this.tokenizer.code(e4)) {
        e4 = e4.substring(r4.raw.length);
        let o4 = t4.at(-1);
        o4?.type === "paragraph" || o4?.type === "text" ? (o4.raw += (o4.raw.endsWith(`
`) ? "" : `
`) + r4.raw, o4.text += `
` + r4.text, this.inlineQueue.at(-1).src = o4.text) : t4.push(r4);
        continue;
      }
      if (r4 = this.tokenizer.fences(e4)) {
        e4 = e4.substring(r4.raw.length), t4.push(r4);
        continue;
      }
      if (r4 = this.tokenizer.heading(e4)) {
        e4 = e4.substring(r4.raw.length), t4.push(r4);
        continue;
      }
      if (r4 = this.tokenizer.hr(e4)) {
        e4 = e4.substring(r4.raw.length), t4.push(r4);
        continue;
      }
      if (r4 = this.tokenizer.blockquote(e4)) {
        e4 = e4.substring(r4.raw.length), t4.push(r4);
        continue;
      }
      if (r4 = this.tokenizer.list(e4)) {
        e4 = e4.substring(r4.raw.length), t4.push(r4);
        continue;
      }
      if (r4 = this.tokenizer.html(e4)) {
        e4 = e4.substring(r4.raw.length), t4.push(r4);
        continue;
      }
      if (r4 = this.tokenizer.def(e4)) {
        e4 = e4.substring(r4.raw.length);
        let o4 = t4.at(-1);
        o4?.type === "paragraph" || o4?.type === "text" ? (o4.raw += (o4.raw.endsWith(`
`) ? "" : `
`) + r4.raw, o4.text += `
` + r4.raw, this.inlineQueue.at(-1).src = o4.text) : this.tokens.links[r4.tag] || (this.tokens.links[r4.tag] = { href: r4.href, title: r4.title }, t4.push(r4));
        continue;
      }
      if (r4 = this.tokenizer.table(e4)) {
        e4 = e4.substring(r4.raw.length), t4.push(r4);
        continue;
      }
      if (r4 = this.tokenizer.lheading(e4)) {
        e4 = e4.substring(r4.raw.length), t4.push(r4);
        continue;
      }
      let i5 = e4;
      if (this.options.extensions?.startBlock) {
        let o4 = 1 / 0, u5 = e4.slice(1), a4;
        this.options.extensions.startBlock.forEach((c4) => {
          a4 = c4.call({ lexer: this }, u5), typeof a4 == "number" && a4 >= 0 && (o4 = Math.min(o4, a4));
        }), o4 < 1 / 0 && o4 >= 0 && (i5 = e4.substring(0, o4 + 1));
      }
      if (this.state.top && (r4 = this.tokenizer.paragraph(i5))) {
        let o4 = t4.at(-1);
        n3 && o4?.type === "paragraph" ? (o4.raw += (o4.raw.endsWith(`
`) ? "" : `
`) + r4.raw, o4.text += `
` + r4.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o4.text) : t4.push(r4), n3 = i5.length !== e4.length, e4 = e4.substring(r4.raw.length);
        continue;
      }
      if (r4 = this.tokenizer.text(e4)) {
        e4 = e4.substring(r4.raw.length);
        let o4 = t4.at(-1);
        o4?.type === "text" ? (o4.raw += (o4.raw.endsWith(`
`) ? "" : `
`) + r4.raw, o4.text += `
` + r4.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o4.text) : t4.push(r4);
        continue;
      }
      if (e4) {
        this.infiniteLoopError(e4.charCodeAt(0));
        break;
      }
    }
    return this.state.top = true, t4;
  }
  inline(e4, t4 = []) {
    return this.inlineQueue.push({ src: e4, tokens: t4 }), t4;
  }
  inlineTokens(e4, t4 = []) {
    this.tokenizer.lexer = this;
    let n3 = e4, s5 = null;
    if (this.tokens.links) {
      let a4 = Object.keys(this.tokens.links);
      if (a4.length > 0) for (; (s5 = this.tokenizer.rules.inline.reflinkSearch.exec(n3)) !== null; ) a4.includes(s5[0].slice(s5[0].lastIndexOf("[") + 1, -1)) && (n3 = n3.slice(0, s5.index) + "[" + "a".repeat(s5[0].length - 2) + "]" + n3.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex));
    }
    for (; (s5 = this.tokenizer.rules.inline.anyPunctuation.exec(n3)) !== null; ) n3 = n3.slice(0, s5.index) + "++" + n3.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
    let r4;
    for (; (s5 = this.tokenizer.rules.inline.blockSkip.exec(n3)) !== null; ) r4 = s5[2] ? s5[2].length : 0, n3 = n3.slice(0, s5.index + r4) + "[" + "a".repeat(s5[0].length - r4 - 2) + "]" + n3.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
    n3 = this.options.hooks?.emStrongMask?.call({ lexer: this }, n3) ?? n3;
    let i5 = false, o4 = "", u5 = 1 / 0;
    for (; e4; ) {
      if (e4.length < u5) u5 = e4.length;
      else {
        this.infiniteLoopError(e4.charCodeAt(0));
        break;
      }
      i5 || (o4 = ""), i5 = false;
      let a4;
      if (this.options.extensions?.inline?.some((p5) => (a4 = p5.call({ lexer: this }, e4, t4)) ? (e4 = e4.substring(a4.raw.length), t4.push(a4), true) : false)) continue;
      if (a4 = this.tokenizer.escape(e4)) {
        e4 = e4.substring(a4.raw.length), t4.push(a4);
        continue;
      }
      if (a4 = this.tokenizer.tag(e4)) {
        e4 = e4.substring(a4.raw.length), t4.push(a4);
        continue;
      }
      if (a4 = this.tokenizer.link(e4)) {
        e4 = e4.substring(a4.raw.length), t4.push(a4);
        continue;
      }
      if (a4 = this.tokenizer.reflink(e4, this.tokens.links)) {
        e4 = e4.substring(a4.raw.length);
        let p5 = t4.at(-1);
        a4.type === "text" && p5?.type === "text" ? (p5.raw += a4.raw, p5.text += a4.text) : t4.push(a4);
        continue;
      }
      if (a4 = this.tokenizer.emStrong(e4, n3, o4)) {
        e4 = e4.substring(a4.raw.length), t4.push(a4);
        continue;
      }
      if (a4 = this.tokenizer.codespan(e4)) {
        e4 = e4.substring(a4.raw.length), t4.push(a4);
        continue;
      }
      if (a4 = this.tokenizer.br(e4)) {
        e4 = e4.substring(a4.raw.length), t4.push(a4);
        continue;
      }
      if (a4 = this.tokenizer.del(e4, n3, o4)) {
        e4 = e4.substring(a4.raw.length), t4.push(a4);
        continue;
      }
      if (a4 = this.tokenizer.autolink(e4)) {
        e4 = e4.substring(a4.raw.length), t4.push(a4);
        continue;
      }
      if (!this.state.inLink && (a4 = this.tokenizer.url(e4))) {
        e4 = e4.substring(a4.raw.length), t4.push(a4);
        continue;
      }
      let c4 = e4;
      if (this.options.extensions?.startInline) {
        let p5 = 1 / 0, k4 = e4.slice(1), h5;
        this.options.extensions.startInline.forEach((R) => {
          h5 = R.call({ lexer: this }, k4), typeof h5 == "number" && h5 >= 0 && (p5 = Math.min(p5, h5));
        }), p5 < 1 / 0 && p5 >= 0 && (c4 = e4.substring(0, p5 + 1));
      }
      if (a4 = this.tokenizer.inlineText(c4)) {
        e4 = e4.substring(a4.raw.length), a4.raw.slice(-1) !== "_" && (o4 = a4.raw.slice(-1)), i5 = true;
        let p5 = t4.at(-1);
        p5?.type === "text" ? (p5.raw += a4.raw, p5.text += a4.text) : t4.push(a4);
        continue;
      }
      if (e4) {
        this.infiniteLoopError(e4.charCodeAt(0));
        break;
      }
    }
    return t4;
  }
  infiniteLoopError(e4) {
    let t4 = "Infinite loop on byte: " + e4;
    if (this.options.silent) console.error(t4);
    else throw new Error(t4);
  }
};
var y4 = class {
  options;
  parser;
  constructor(e4) {
    this.options = e4 || T3;
  }
  space(e4) {
    return "";
  }
  code({ text: e4, lang: t4, escaped: n3 }) {
    let s5 = (t4 || "").match(m5.notSpaceStart)?.[0], r4 = e4.replace(m5.endingNewline, "") + `
`;
    return s5 ? '<pre><code class="language-' + O2(s5) + '">' + (n3 ? r4 : O2(r4, true)) + `</code></pre>
` : "<pre><code>" + (n3 ? r4 : O2(r4, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e4 }) {
    return `<blockquote>
${this.parser.parse(e4)}</blockquote>
`;
  }
  html({ text: e4 }) {
    return e4;
  }
  def(e4) {
    return "";
  }
  heading({ tokens: e4, depth: t4 }) {
    return `<h${t4}>${this.parser.parseInline(e4)}</h${t4}>
`;
  }
  hr(e4) {
    return `<hr>
`;
  }
  list(e4) {
    let t4 = e4.ordered, n3 = e4.start, s5 = "";
    for (let o4 = 0; o4 < e4.items.length; o4++) {
      let u5 = e4.items[o4];
      s5 += this.listitem(u5);
    }
    let r4 = t4 ? "ol" : "ul", i5 = t4 && n3 !== 1 ? ' start="' + n3 + '"' : "";
    return "<" + r4 + i5 + `>
` + s5 + "</" + r4 + `>
`;
  }
  listitem(e4) {
    return `<li>${this.parser.parse(e4.tokens)}</li>
`;
  }
  checkbox({ checked: e4 }) {
    return "<input " + (e4 ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e4 }) {
    return `<p>${this.parser.parseInline(e4)}</p>
`;
  }
  table(e4) {
    let t4 = "", n3 = "";
    for (let r4 = 0; r4 < e4.header.length; r4++) n3 += this.tablecell(e4.header[r4]);
    t4 += this.tablerow({ text: n3 });
    let s5 = "";
    for (let r4 = 0; r4 < e4.rows.length; r4++) {
      let i5 = e4.rows[r4];
      n3 = "";
      for (let o4 = 0; o4 < i5.length; o4++) n3 += this.tablecell(i5[o4]);
      s5 += this.tablerow({ text: n3 });
    }
    return s5 && (s5 = `<tbody>${s5}</tbody>`), `<table>
<thead>
` + t4 + `</thead>
` + s5 + `</table>
`;
  }
  tablerow({ text: e4 }) {
    return `<tr>
${e4}</tr>
`;
  }
  tablecell(e4) {
    let t4 = this.parser.parseInline(e4.tokens), n3 = e4.header ? "th" : "td";
    return (e4.align ? `<${n3} align="${e4.align}">` : `<${n3}>`) + t4 + `</${n3}>
`;
  }
  strong({ tokens: e4 }) {
    return `<strong>${this.parser.parseInline(e4)}</strong>`;
  }
  em({ tokens: e4 }) {
    return `<em>${this.parser.parseInline(e4)}</em>`;
  }
  codespan({ text: e4 }) {
    return `<code>${O2(e4, true)}</code>`;
  }
  br(e4) {
    return "<br>";
  }
  del({ tokens: e4 }) {
    return `<del>${this.parser.parseInline(e4)}</del>`;
  }
  link({ href: e4, title: t4, tokens: n3 }) {
    let s5 = this.parser.parseInline(n3), r4 = V2(e4);
    if (r4 === null) return s5;
    e4 = r4;
    let i5 = '<a href="' + e4 + '"';
    return t4 && (i5 += ' title="' + O2(t4) + '"'), i5 += ">" + s5 + "</a>", i5;
  }
  image({ href: e4, title: t4, text: n3, tokens: s5 }) {
    s5 && (n3 = this.parser.parseInline(s5, this.parser.textRenderer));
    let r4 = V2(e4);
    if (r4 === null) return O2(n3);
    e4 = r4;
    let i5 = `<img src="${e4}" alt="${O2(n3)}"`;
    return t4 && (i5 += ` title="${O2(t4)}"`), i5 += ">", i5;
  }
  text(e4) {
    return "tokens" in e4 && e4.tokens ? this.parser.parseInline(e4.tokens) : "escaped" in e4 && e4.escaped ? e4.text : O2(e4.text);
  }
};
var L2 = class {
  strong({ text: e4 }) {
    return e4;
  }
  em({ text: e4 }) {
    return e4;
  }
  codespan({ text: e4 }) {
    return e4;
  }
  del({ text: e4 }) {
    return e4;
  }
  html({ text: e4 }) {
    return e4;
  }
  text({ text: e4 }) {
    return e4;
  }
  link({ text: e4 }) {
    return "" + e4;
  }
  image({ text: e4 }) {
    return "" + e4;
  }
  br() {
    return "";
  }
  checkbox({ raw: e4 }) {
    return e4;
  }
};
var b3 = class l6 {
  options;
  renderer;
  textRenderer;
  constructor(e4) {
    this.options = e4 || T3, this.options.renderer = this.options.renderer || new y4(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new L2();
  }
  static parse(e4, t4) {
    return new l6(t4).parse(e4);
  }
  static parseInline(e4, t4) {
    return new l6(t4).parseInline(e4);
  }
  parse(e4) {
    this.renderer.parser = this;
    let t4 = "";
    for (let n3 = 0; n3 < e4.length; n3++) {
      let s5 = e4[n3];
      if (this.options.extensions?.renderers?.[s5.type]) {
        let i5 = s5, o4 = this.options.extensions.renderers[i5.type].call({ parser: this }, i5);
        if (o4 !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "def", "paragraph", "text"].includes(i5.type)) {
          t4 += o4 || "";
          continue;
        }
      }
      let r4 = s5;
      switch (r4.type) {
        case "space": {
          t4 += this.renderer.space(r4);
          break;
        }
        case "hr": {
          t4 += this.renderer.hr(r4);
          break;
        }
        case "heading": {
          t4 += this.renderer.heading(r4);
          break;
        }
        case "code": {
          t4 += this.renderer.code(r4);
          break;
        }
        case "table": {
          t4 += this.renderer.table(r4);
          break;
        }
        case "blockquote": {
          t4 += this.renderer.blockquote(r4);
          break;
        }
        case "list": {
          t4 += this.renderer.list(r4);
          break;
        }
        case "checkbox": {
          t4 += this.renderer.checkbox(r4);
          break;
        }
        case "html": {
          t4 += this.renderer.html(r4);
          break;
        }
        case "def": {
          t4 += this.renderer.def(r4);
          break;
        }
        case "paragraph": {
          t4 += this.renderer.paragraph(r4);
          break;
        }
        case "text": {
          t4 += this.renderer.text(r4);
          break;
        }
        default: {
          let i5 = 'Token with "' + r4.type + '" type was not found.';
          if (this.options.silent) return console.error(i5), "";
          throw new Error(i5);
        }
      }
    }
    return t4;
  }
  parseInline(e4, t4 = this.renderer) {
    this.renderer.parser = this;
    let n3 = "";
    for (let s5 = 0; s5 < e4.length; s5++) {
      let r4 = e4[s5];
      if (this.options.extensions?.renderers?.[r4.type]) {
        let o4 = this.options.extensions.renderers[r4.type].call({ parser: this }, r4);
        if (o4 !== false || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(r4.type)) {
          n3 += o4 || "";
          continue;
        }
      }
      let i5 = r4;
      switch (i5.type) {
        case "escape": {
          n3 += t4.text(i5);
          break;
        }
        case "html": {
          n3 += t4.html(i5);
          break;
        }
        case "link": {
          n3 += t4.link(i5);
          break;
        }
        case "image": {
          n3 += t4.image(i5);
          break;
        }
        case "checkbox": {
          n3 += t4.checkbox(i5);
          break;
        }
        case "strong": {
          n3 += t4.strong(i5);
          break;
        }
        case "em": {
          n3 += t4.em(i5);
          break;
        }
        case "codespan": {
          n3 += t4.codespan(i5);
          break;
        }
        case "br": {
          n3 += t4.br(i5);
          break;
        }
        case "del": {
          n3 += t4.del(i5);
          break;
        }
        case "text": {
          n3 += t4.text(i5);
          break;
        }
        default: {
          let o4 = 'Token with "' + i5.type + '" type was not found.';
          if (this.options.silent) return console.error(o4), "";
          throw new Error(o4);
        }
      }
    }
    return n3;
  }
};
var P2 = class {
  options;
  block;
  constructor(e4) {
    this.options = e4 || T3;
  }
  static passThroughHooks = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
  static passThroughHooksRespectAsync = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"]);
  preprocess(e4) {
    return e4;
  }
  postprocess(e4) {
    return e4;
  }
  processAllTokens(e4) {
    return e4;
  }
  emStrongMask(e4) {
    return e4;
  }
  provideLexer(e4 = this.block) {
    return e4 ? x4.lex : x4.lexInline;
  }
  provideParser(e4 = this.block) {
    return e4 ? b3.parse : b3.parseInline;
  }
};
var q3 = class {
  defaults = M2();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = b3;
  Renderer = y4;
  TextRenderer = L2;
  Lexer = x4;
  Tokenizer = w4;
  Hooks = P2;
  constructor(...e4) {
    this.use(...e4);
  }
  walkTokens(e4, t4) {
    let n3 = [];
    for (let s5 of e4) switch (n3 = n3.concat(t4.call(this, s5)), s5.type) {
      case "table": {
        let r4 = s5;
        for (let i5 of r4.header) n3 = n3.concat(this.walkTokens(i5.tokens, t4));
        for (let i5 of r4.rows) for (let o4 of i5) n3 = n3.concat(this.walkTokens(o4.tokens, t4));
        break;
      }
      case "list": {
        let r4 = s5;
        n3 = n3.concat(this.walkTokens(r4.items, t4));
        break;
      }
      default: {
        let r4 = s5;
        this.defaults.extensions?.childTokens?.[r4.type] ? this.defaults.extensions.childTokens[r4.type].forEach((i5) => {
          let o4 = r4[i5].flat(1 / 0);
          n3 = n3.concat(this.walkTokens(o4, t4));
        }) : r4.tokens && (n3 = n3.concat(this.walkTokens(r4.tokens, t4)));
      }
    }
    return n3;
  }
  use(...e4) {
    let t4 = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return e4.forEach((n3) => {
      let s5 = { ...n3 };
      if (s5.async = this.defaults.async || s5.async || false, n3.extensions && (n3.extensions.forEach((r4) => {
        if (!r4.name) throw new Error("extension name required");
        if ("renderer" in r4) {
          let i5 = t4.renderers[r4.name];
          i5 ? t4.renderers[r4.name] = function(...o4) {
            let u5 = r4.renderer.apply(this, o4);
            return u5 === false && (u5 = i5.apply(this, o4)), u5;
          } : t4.renderers[r4.name] = r4.renderer;
        }
        if ("tokenizer" in r4) {
          if (!r4.level || r4.level !== "block" && r4.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
          let i5 = t4[r4.level];
          i5 ? i5.unshift(r4.tokenizer) : t4[r4.level] = [r4.tokenizer], r4.start && (r4.level === "block" ? t4.startBlock ? t4.startBlock.push(r4.start) : t4.startBlock = [r4.start] : r4.level === "inline" && (t4.startInline ? t4.startInline.push(r4.start) : t4.startInline = [r4.start]));
        }
        "childTokens" in r4 && r4.childTokens && (t4.childTokens[r4.name] = r4.childTokens);
      }), s5.extensions = t4), n3.renderer) {
        let r4 = this.defaults.renderer || new y4(this.defaults);
        for (let i5 in n3.renderer) {
          if (!(i5 in r4)) throw new Error(`renderer '${i5}' does not exist`);
          if (["options", "parser"].includes(i5)) continue;
          let o4 = i5, u5 = n3.renderer[o4], a4 = r4[o4];
          r4[o4] = (...c4) => {
            let p5 = u5.apply(r4, c4);
            return p5 === false && (p5 = a4.apply(r4, c4)), p5 || "";
          };
        }
        s5.renderer = r4;
      }
      if (n3.tokenizer) {
        let r4 = this.defaults.tokenizer || new w4(this.defaults);
        for (let i5 in n3.tokenizer) {
          if (!(i5 in r4)) throw new Error(`tokenizer '${i5}' does not exist`);
          if (["options", "rules", "lexer"].includes(i5)) continue;
          let o4 = i5, u5 = n3.tokenizer[o4], a4 = r4[o4];
          r4[o4] = (...c4) => {
            let p5 = u5.apply(r4, c4);
            return p5 === false && (p5 = a4.apply(r4, c4)), p5;
          };
        }
        s5.tokenizer = r4;
      }
      if (n3.hooks) {
        let r4 = this.defaults.hooks || new P2();
        for (let i5 in n3.hooks) {
          if (!(i5 in r4)) throw new Error(`hook '${i5}' does not exist`);
          if (["options", "block"].includes(i5)) continue;
          let o4 = i5, u5 = n3.hooks[o4], a4 = r4[o4];
          P2.passThroughHooks.has(i5) ? r4[o4] = (c4) => {
            if (this.defaults.async && P2.passThroughHooksRespectAsync.has(i5)) return (async () => {
              let k4 = await u5.call(r4, c4);
              return a4.call(r4, k4);
            })();
            let p5 = u5.call(r4, c4);
            return a4.call(r4, p5);
          } : r4[o4] = (...c4) => {
            if (this.defaults.async) return (async () => {
              let k4 = await u5.apply(r4, c4);
              return k4 === false && (k4 = await a4.apply(r4, c4)), k4;
            })();
            let p5 = u5.apply(r4, c4);
            return p5 === false && (p5 = a4.apply(r4, c4)), p5;
          };
        }
        s5.hooks = r4;
      }
      if (n3.walkTokens) {
        let r4 = this.defaults.walkTokens, i5 = n3.walkTokens;
        s5.walkTokens = function(o4) {
          let u5 = [];
          return u5.push(i5.call(this, o4)), r4 && (u5 = u5.concat(r4.call(this, o4))), u5;
        };
      }
      this.defaults = { ...this.defaults, ...s5 };
    }), this;
  }
  setOptions(e4) {
    return this.defaults = { ...this.defaults, ...e4 }, this;
  }
  lexer(e4, t4) {
    return x4.lex(e4, t4 ?? this.defaults);
  }
  parser(e4, t4) {
    return b3.parse(e4, t4 ?? this.defaults);
  }
  parseMarkdown(e4) {
    return (n3, s5) => {
      let r4 = { ...s5 }, i5 = { ...this.defaults, ...r4 }, o4 = this.onError(!!i5.silent, !!i5.async);
      if (this.defaults.async === true && r4.async === false) return o4(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n3 > "u" || n3 === null) return o4(new Error("marked(): input parameter is undefined or null"));
      if (typeof n3 != "string") return o4(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n3) + ", string expected"));
      if (i5.hooks && (i5.hooks.options = i5, i5.hooks.block = e4), i5.async) return (async () => {
        let u5 = i5.hooks ? await i5.hooks.preprocess(n3) : n3, c4 = await (i5.hooks ? await i5.hooks.provideLexer(e4) : e4 ? x4.lex : x4.lexInline)(u5, i5), p5 = i5.hooks ? await i5.hooks.processAllTokens(c4) : c4;
        i5.walkTokens && await Promise.all(this.walkTokens(p5, i5.walkTokens));
        let h5 = await (i5.hooks ? await i5.hooks.provideParser(e4) : e4 ? b3.parse : b3.parseInline)(p5, i5);
        return i5.hooks ? await i5.hooks.postprocess(h5) : h5;
      })().catch(o4);
      try {
        i5.hooks && (n3 = i5.hooks.preprocess(n3));
        let a4 = (i5.hooks ? i5.hooks.provideLexer(e4) : e4 ? x4.lex : x4.lexInline)(n3, i5);
        i5.hooks && (a4 = i5.hooks.processAllTokens(a4)), i5.walkTokens && this.walkTokens(a4, i5.walkTokens);
        let p5 = (i5.hooks ? i5.hooks.provideParser(e4) : e4 ? b3.parse : b3.parseInline)(a4, i5);
        return i5.hooks && (p5 = i5.hooks.postprocess(p5)), p5;
      } catch (u5) {
        return o4(u5);
      }
    };
  }
  onError(e4, t4) {
    return (n3) => {
      if (n3.message += `
Please report this to https://github.com/markedjs/marked.`, e4) {
        let s5 = "<p>An error occurred:</p><pre>" + O2(n3.message + "", true) + "</pre>";
        return t4 ? Promise.resolve(s5) : s5;
      }
      if (t4) return Promise.reject(n3);
      throw n3;
    };
  }
};
var z3 = new q3();
function g5(l7, e4) {
  return z3.parse(l7, e4);
}
g5.options = g5.setOptions = function(l7) {
  return z3.setOptions(l7), g5.defaults = z3.defaults, N2(g5.defaults), g5;
};
g5.getDefaults = M2;
g5.defaults = T3;
g5.use = function(...l7) {
  return z3.use(...l7), g5.defaults = z3.defaults, N2(g5.defaults), g5;
};
g5.walkTokens = function(l7, e4) {
  return z3.walkTokens(l7, e4);
};
g5.parseInline = z3.parseInline;
g5.Parser = b3;
g5.parser = b3.parse;
g5.Renderer = y4;
g5.TextRenderer = L2;
g5.Lexer = x4;
g5.lexer = x4.lex;
g5.Tokenizer = w4;
g5.Hooks = P2;
g5.parse = g5;
var Ft = g5.options;
var Ut = g5.setOptions;
var Kt = g5.use;
var Wt = g5.walkTokens;
var Xt = g5.parseInline;
var Vt = b3.parse;
var Yt = x4.lex;

// src/utils.ts
g5.use({
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const isAbs = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
      const titleAttr = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
      const targetAttr = isAbs ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${href}"${titleAttr}${targetAttr}>${text}</a>`;
    }
  }
});
g5.use({
  extensions: [
    {
      name: "msgRef",
      level: "inline",
      start(src) {
        return src.indexOf("[[msg:");
      },
      tokenizer(src) {
        const m6 = src.match(/^\[\[msg:([^\]|]+)\|([^\]]+)\]\]/);
        if (m6) {
          return {
            type: "msgRef",
            raw: m6[0],
            messageId: m6[1],
            threadId: m6[2]
          };
        }
        return void 0;
      },
      renderer(token) {
        const { messageId, threadId: threadId2 } = token;
        return `<a href="#" class="msg-ref" data-msg-id="${messageId}" data-thread-id="${threadId2}" title="Jump to message">\u{1F517} referenced message</a>`;
      }
    }
  ]
});
function fmtBytes(n3) {
  if (n3 == null) return "";
  if (n3 < 1024) return n3 + " B";
  if (n3 < 1024 * 1024) return (n3 / 1024).toFixed(1) + " K";
  if (n3 < 1024 * 1024 * 1024) return (n3 / 1024 / 1024).toFixed(1) + " M";
  return (n3 / 1024 / 1024 / 1024).toFixed(1) + " G";
}
function fmtBytesShort(n3) {
  if (n3 == null) return "";
  if (n3 < 1024) return n3 + " B";
  if (n3 < 1024 * 1024) return (n3 / 1024).toFixed(0) + " KB";
  return (n3 / (1024 * 1024)).toFixed(1) + " MB";
}
function fmtRelative(ts) {
  if (!ts) return "";
  const norm = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  const t4 = Date.parse(norm);
  if (!t4) return "";
  const sec = Math.max(0, (Date.now() - t4) / 1e3);
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h";
  if (sec < 86400 * 7) return Math.floor(sec / 86400) + "d";
  return new Date(t4).toLocaleDateString();
}
function fmtAbsolute(ts) {
  if (!ts) return "";
  const norm = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  const t4 = Date.parse(norm);
  if (!t4) return "";
  return new Date(t4).toLocaleString();
}
function tsKey(s5) {
  if (!s5) return 0;
  const norm = s5.includes("T") ? s5 : s5.replace(" ", "T") + "Z";
  const n3 = Date.parse(norm);
  return Number.isFinite(n3) ? n3 : 0;
}
function parentPath(p5) {
  const i5 = p5.lastIndexOf("/");
  return i5 < 0 ? "" : p5.slice(0, i5);
}
function normalizeFileLinks(text) {
  const re = /\[([^\]\n]+)\]\(([^<>\n()]*(?:\([^()\n]*\)[^<>\n()]*)*)\)/g;
  return text.replace(re, (match2, label, dest) => {
    const d5 = dest.trim();
    if (!d5) return match2;
    if (/^[a-z][a-z0-9+.-]*:/i.test(d5)) return match2;
    if (d5.startsWith("#") || d5.startsWith("//") || d5.startsWith("mailto:")) return match2;
    if (!/[ ()]/.test(d5)) return match2;
    return `[${label}](<${d5}>)`;
  });
}
function renderMarkdown(text) {
  try {
    return g5.parse(normalizeFileLinks(text || ""), { breaks: true, gfm: true });
  } catch {
    return null;
  }
}
function highlightTextNodes(root, query) {
  if (!query) return;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  const skip = /* @__PURE__ */ new Set(["CODE", "PRE", "A", "MARK", "SCRIPT", "STYLE"]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p5 = node.parentElement;
      while (p5 && p5 !== root) {
        if (skip.has(p5.tagName)) return NodeFilter.FILTER_REJECT;
        p5 = p5.parentElement;
      }
      return re.test(node.textContent || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const textNode of nodes) {
    const frag = document.createDocumentFragment();
    const parts = textNode.textContent.split(re);
    for (const part of parts) {
      if (re.test(part)) {
        const mark = document.createElement("mark");
        mark.className = "search-hl";
        mark.textContent = part;
        frag.appendChild(mark);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
      re.lastIndex = 0;
    }
    textNode.parentNode.replaceChild(frag, textNode);
  }
}
function rewriteFileLinks(root, groupId2, onNavFile) {
  if (!groupId2 || !root) return;
  const gid = encodeURIComponent(groupId2);
  const isExternal = (h5) => /^[a-z][a-z0-9+.-]*:/i.test(h5) || h5.startsWith("#") || h5.startsWith("//") || h5.startsWith("mailto:");
  const decodeHref = (h5) => {
    try {
      return decodeURIComponent(h5);
    } catch {
      return h5;
    }
  };
  const normalizeRel = (p5) => String(p5 || "").replace(/^\.?\/+/, "").replace(/^workspace\/+/, "");
  const toFileUrl = (rel) => {
    const segs = rel.split("/").filter(Boolean).map(encodeURIComponent);
    return `api/groups/${gid}/files/${segs.join("/")}`;
  };
  const attachPreviewClick = (a4, rel) => {
    a4.addEventListener("click", (ev) => {
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      onNavFile({ path: rel, name: rel.slice(rel.lastIndexOf("/") + 1) });
    });
  };
  root.querySelectorAll("a[href]").forEach((a4) => {
    const href = a4.getAttribute("href") || "";
    if (!href || isExternal(href)) return;
    const rel = normalizeRel(decodeHref(href));
    if (!rel) return;
    a4.setAttribute("href", toFileUrl(rel));
    a4.setAttribute("target", "_blank");
    a4.setAttribute("rel", "noopener");
    attachPreviewClick(a4, rel);
  });
  const fileLikeRe = /^[\w.\-/ ]+\.[A-Za-z0-9]{1,8}$/;
  root.querySelectorAll("code").forEach((c4) => {
    if (c4.closest("pre")) return;
    const txt = c4.textContent || "";
    if (!fileLikeRe.test(txt)) return;
    if (txt.length > 200) return;
    const rel = normalizeRel(txt);
    if (!rel) return;
    const a4 = document.createElement("a");
    a4.href = toFileUrl(rel);
    a4.target = "_blank";
    a4.rel = "noopener";
    a4.textContent = txt;
    attachPreviewClick(a4, rel);
    c4.replaceWith(a4);
  });
}

// src/hash.ts
var PATTERNS = ["/g/:gid/t/:tid/:kind/*filepath", "/g/:gid/t/:tid", "/g/:gid/:kind/*filepath", "/g/:gid"];
var matchers = PATTERNS.map((p5) => (0, import_path_to_regexp.match)(p5));
var builders = Object.fromEntries(
  PATTERNS.map((p5) => [p5, (0, import_path_to_regexp.compile)(p5)])
);
function parseHash() {
  const raw = location.hash.replace(/^#/, "").replace(/\/$/, "");
  if (!raw) return null;
  const test = "/" + raw;
  for (const m6 of matchers) {
    const r4 = m6(test);
    if (!r4) continue;
    const params = r4.params;
    const gid = String(params.gid || "");
    const tid = params.tid ? String(params.tid) : null;
    const kind = params.kind ? String(params.kind) : "";
    const filepath = params.filepath;
    if (kind && kind !== "f" && kind !== "d") continue;
    const path = Array.isArray(filepath) ? filepath.join("/") : filepath ? String(filepath) : "";
    return {
      groupId: gid,
      threadId: tid,
      path,
      isDir: !kind || kind === "d"
    };
  }
  return null;
}
function buildHash() {
  if (!groupId.value) return "";
  const hasThread = !!threadId.value;
  const path = filePath.value || treePath.value;
  const hasPath = !!path;
  let pattern;
  if (hasThread && hasPath) pattern = "/g/:gid/t/:tid/:kind/*filepath";
  else if (hasThread) pattern = "/g/:gid/t/:tid";
  else if (hasPath) pattern = "/g/:gid/:kind/*filepath";
  else pattern = "/g/:gid";
  const params = { gid: groupId.value };
  if (hasThread) params.tid = threadId.value;
  if (hasPath) {
    params.kind = filePath.value ? "f" : "d";
    params.filepath = String(path).split("/").filter(Boolean);
  }
  let s5 = builders[pattern](params);
  if (hasPath && !filePath.value) s5 += "/";
  return "#" + s5.slice(1);
}
function writeHash() {
  const h5 = buildHash();
  if (!h5) return;
  if (location.hash !== h5) {
    refs.suppressHashCount++;
    location.hash = h5;
  }
}
function threadCtx(t4) {
  if (!t4) return null;
  if (!t4.channelType || t4.channelType === "web") return null;
  return { channelType: t4.channelType, messagingGroupId: t4.messagingGroupId ?? null, canSend: !!t4.canSend };
}
async function applyHash(router2) {
  const parsed = parseHash();
  if (!parsed) {
    if (groups.value.length) await router2.selectGroup(groups.value[0].id);
    return;
  }
  if (!groups.value.find((g8) => g8.id === parsed.groupId)) {
    router2.notFound("No access to group " + parsed.groupId);
    return;
  }
  const groupChanged = groupId.value !== parsed.groupId;
  n2(() => {
    groupId.value = parsed.groupId;
    filePath.value = null;
  });
  if (groupChanged) await router2.loadThreads(parsed.groupId);
  if (parsed.threadId) {
    router2.openChat(parsed.groupId, parsed.threadId, null).catch((err) => console.error("chat open failed", err));
  } else if (groupChanged) {
    const latest = threads.value.length > 0 ? threads.value[0] : null;
    if (latest)
      router2.openChat(parsed.groupId, latest.threadId, threadCtx(latest)).catch((err) => console.error("chat open failed", err));
    else router2.openChat(parsed.groupId, null, null).catch((err) => console.error("auto-start chat failed", err));
  }
  if (parsed.isDir) {
    await router2.loadTree(parsed.path);
  } else {
    const parent = parentPath(parsed.path);
    await router2.loadTree(parent);
    const name = parent ? parsed.path.slice(parent.length + 1) : parsed.path;
    await router2.selectFile({ path: parsed.path, name });
  }
}

// node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js
var f4 = 0;
var i4 = Array.isArray;
function u4(e4, t4, n3, o4, i5, u5) {
  t4 || (t4 = {});
  var a4, c4, p5 = t4;
  if ("ref" in p5) for (c4 in p5 = {}, t4) "ref" == c4 ? a4 = t4[c4] : p5[c4] = t4[c4];
  var l7 = { type: e4, props: p5, key: n3, ref: a4, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: --f4, __i: -1, __u: 0, __source: i5, __self: u5 };
  if ("function" == typeof e4 && (a4 = e4.defaultProps)) for (c4 in a4) void 0 === p5[c4] && (p5[c4] = a4[c4]);
  return l.vnode && l.vnode(l7), l7;
}

// src/components/Toast.tsx
var nextId = 1;
var hideTimer = null;
function showToast(text, kind = "ok", ms = 1800) {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const id = nextId++;
  toastMessage.value = { id, text, kind };
  hideTimer = setTimeout(() => {
    if (toastMessage.value && toastMessage.value.id === id) toastMessage.value = null;
    hideTimer = null;
  }, ms);
}
function showStickyToast(text, action, kind = "ok") {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const id = nextId++;
  toastMessage.value = { id, text, kind, action };
}
function Toast() {
  const t4 = toastMessage.value;
  y2(() => void 0, [t4?.id]);
  if (!t4) return null;
  const sticky = !!t4.action;
  return /* @__PURE__ */ u4(
    "div",
    {
      class: "toast toast-" + (t4.kind || "ok") + (sticky ? " toast-sticky" : ""),
      role: "status",
      "aria-live": "polite",
      children: [
        /* @__PURE__ */ u4("span", { class: "toast-text", children: t4.text }),
        t4.action ? /* @__PURE__ */ u4("button", { type: "button", class: "toast-action", onClick: t4.action.onClick, children: t4.action.label }) : null
      ]
    },
    t4.id
  );
}

// src/badge.ts
var unread = 0;
var initialized = false;
function nav() {
  if (typeof navigator === "undefined") return null;
  const n3 = navigator;
  return typeof n3.setAppBadge === "function" ? n3 : null;
}
function apply() {
  const n3 = nav();
  if (!n3) return;
  if (unread <= 0) {
    void n3.clearAppBadge?.();
  } else {
    void n3.setAppBadge?.(unread);
  }
}
function initBadge() {
  if (initialized) return;
  initialized = true;
  if (!nav()) return;
  const clear = () => {
    if (document.visibilityState === "visible") {
      unread = 0;
      apply();
    }
  };
  document.addEventListener("visibilitychange", clear);
  window.addEventListener("focus", clear);
  clear();
}
function bumpUnread() {
  if (!nav()) return;
  if (document.visibilityState === "visible") return;
  unread += 1;
  apply();
}

// src/notify.ts
var registration = null;
var updatePromptShown = false;
function loadMuted() {
  try {
    return localStorage.getItem(NOTIF_MUTE_KEY) === "1";
  } catch {
    return false;
  }
}
function initNotif() {
  notifMutedSig.value = loadMuted();
  j3(() => {
    try {
      localStorage.setItem(NOTIF_MUTE_KEY, notifMutedSig.value ? "1" : "0");
    } catch {
    }
  });
  void registerServiceWorker().then(() => {
    if (!notifMutedSig.value) void ensureSubscribed();
  });
}
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const existing = await navigator.serviceWorker.getRegistration("/ui/chat/");
    if (existing && !existing.active && !existing.installing && !existing.waiting) {
      await existing.unregister().catch(() => {
      });
    }
    registration = await navigator.serviceWorker.register("/ui/chat/sw.js", {
      scope: "/ui/chat/",
      updateViaCache: "none"
    });
    watchForUpdates(registration);
  } catch (err) {
    console.warn("SW register failed", err);
  }
}
function watchForUpdates(reg) {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  const onNewWorker = (worker) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        promptForUpdate(worker);
      }
    });
  };
  if (reg.waiting && navigator.serviceWorker.controller) {
    promptForUpdate(reg.waiting);
  }
  reg.addEventListener("updatefound", () => {
    if (reg.installing) onNewWorker(reg.installing);
  });
}
function promptForUpdate(worker) {
  if (updatePromptShown) return;
  updatePromptShown = true;
  showStickyToast("New version available", {
    label: "Reload",
    onClick: () => {
      worker.postMessage({ type: "SKIP_WAITING" });
    }
  });
}
function toggleMute() {
  notifMutedSig.value = !notifMutedSig.value;
  if (notifMutedSig.value) {
    void unsubscribePush();
  } else {
    void ensureSubscribed();
  }
}
async function ensureSubscribed() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (permission !== "granted") {
    notifMutedSig.value = true;
    return;
  }
  if (!registration) {
    try {
      registration = await navigator.serviceWorker.ready;
    } catch {
      return;
    }
  }
  try {
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      const keyResp = await fetch("api/push/public-key", { credentials: "include" });
      if (!keyResp.ok) return;
      const { publicKey } = await keyResp.json();
      if (!publicKey) return;
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer
      });
    }
    await fetch("api/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON())
    });
  } catch (err) {
    console.warn("push subscribe failed", err);
  }
}
async function unsubscribePush() {
  if (!registration) return;
  try {
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch("api/push/subscribe", {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint })
    });
  } catch (err) {
    console.warn("push unsubscribe failed", err);
  }
}
function maybeNotify(_text, _files) {
  if (notifMutedSig.value) return;
  bumpUnread();
}
function shouldShowIosInstallHint() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  if (!isIos) return false;
  const standalone = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  return !standalone;
}
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i5 = 0; i5 < rawData.length; ++i5) outputArray[i5] = rawData.charCodeAt(i5);
  return outputArray;
}

// src/sound.ts
var ctx = null;
var unlocked = false;
function ensureCtx() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch {
    return null;
  }
  return ctx;
}
function unlock() {
  const c4 = ensureCtx();
  if (!c4) return;
  if (c4.state === "suspended") void c4.resume().catch(() => {
  });
  unlocked = true;
}
function loadBool(key, fallback) {
  try {
    const v5 = localStorage.getItem(key);
    return v5 == null ? fallback : v5 === "1";
  } catch {
    return fallback;
  }
}
function initSound() {
  progressSoundMutedSig.value = loadBool(PROGRESS_SOUND_KEY, false);
  completionSoundMutedSig.value = loadBool(COMPLETION_SOUND_KEY, false);
  j3(() => {
    try {
      localStorage.setItem(PROGRESS_SOUND_KEY, progressSoundMutedSig.value ? "1" : "0");
    } catch {
    }
  });
  j3(() => {
    try {
      localStorage.setItem(COMPLETION_SOUND_KEY, completionSoundMutedSig.value ? "1" : "0");
    } catch {
    }
  });
  const opts = { once: true, passive: true };
  for (const ev of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(ev, unlock, opts);
  }
}
function tone(freq, durMs, peak = 0.05, type = "sine") {
  const c4 = ensureCtx();
  if (!c4) return;
  if (c4.state === "suspended") void c4.resume().catch(() => {
  });
  if (!unlocked && c4.state !== "running") return;
  const now = c4.currentTime;
  const osc = c4.createOscillator();
  const gain = c4.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  gain.gain.setValueAtTime(1e-4, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(1e-4, now + durMs / 1e3);
  osc.connect(gain).connect(c4.destination);
  osc.start(now);
  osc.stop(now + durMs / 1e3 + 0.02);
}
var lastTick = 0;
var TICK_MIN_INTERVAL_MS = 2e3;
function playProgressTick() {
  if (progressSoundMutedSig.value) return;
  const now = Date.now();
  if (now - lastTick < TICK_MIN_INTERVAL_MS) return;
  lastTick = now;
  tone(660, 70, 0.04);
}
function playCompletionChime() {
  if (completionSoundMutedSig.value) return;
  tone(660, 120, 0.05);
  setTimeout(() => tone(880, 180, 0.05), 110);
}

// src/actions.ts
function focusComposerSoon() {
  if (isMobile.value) return;
  let tries = 0;
  const attempt = () => {
    const el = document.getElementById("chat-input");
    if (el && !el.disabled) {
      el.focus();
      return;
    }
    if (++tries < 180) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
function requestScrollToBottom() {
  scrollToBottomTick.value++;
}
async function loadThreads(_gid) {
  await runSync();
}
async function deleteThread(tid) {
  if (!groupId.value) return;
  try {
    const r4 = await fetch(`api/groups/${encodeURIComponent(groupId.value)}/chat/${encodeURIComponent(tid)}`, {
      method: "DELETE",
      credentials: "same-origin"
    });
    if (!r4.ok) {
      chatStatus.value = "delete failed (HTTP " + r4.status + ")";
      return;
    }
  } catch (err) {
    console.error("delete failed", err);
    const m6 = err instanceof Error ? err.message : "network error";
    chatStatus.value = "delete failed: " + m6;
    return;
  }
  threads.value = threads.value.filter((x6) => x6.threadId !== tid);
  if (threadId.value === tid) {
    const latest = threads.value.length > 0 ? threads.value[0] : null;
    if (latest) openChat(groupId.value, latest.threadId, threadCtxOf(latest)).catch(console.error);
    else clearChat();
  }
}
function threadCtxOf(t4) {
  if (!t4 || !t4.channelType || t4.channelType === "web") return null;
  return { channelType: t4.channelType, messagingGroupId: t4.messagingGroupId ?? null, canSend: !!t4.canSend };
}
function bumpActiveThread(maxTs) {
  if (!threadId.value) return;
  const list = threads.value.slice();
  const idx = list.findIndex((x6) => x6.threadId === threadId.value);
  if (idx < 0) {
    if (groupId.value) loadThreads(groupId.value);
    return;
  }
  const t4 = { ...list[idx] };
  t4.lastActivityAt = maxTs || (/* @__PURE__ */ new Date()).toISOString();
  t4.messageCount = (t4.messageCount || 0) + 1;
  list.splice(idx, 1);
  list.unshift(t4);
  threads.value = list;
}
function updateActiveThreadTitleFromFirstMessage(text) {
  if (!threadId.value) return;
  const list = threads.value.slice();
  const idx = list.findIndex((x6) => x6.threadId === threadId.value);
  if (idx < 0) return;
  const t4 = list[idx];
  if (t4.title !== "(new thread)") return;
  const clean = String(text || "").replace(/^>\s*Context[^\n]*\n+/i, "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  list[idx] = { ...t4, title: clean.slice(0, 60) };
  threads.value = list;
}
async function searchThreads(gid, query) {
  if (!query.trim()) {
    clearSearch();
    return;
  }
  searchLoading.value = true;
  searchQuery.value = query;
  try {
    let url = `api/groups/${encodeURIComponent(gid)}/chat/search?q=${encodeURIComponent(query)}`;
    const { results } = await api(url);
    searchResults.value = results ?? [];
  } catch (err) {
    console.error("search failed", err);
    searchResults.value = [];
  } finally {
    searchLoading.value = false;
  }
}
function clearSearch() {
  n2(() => {
    searchQuery.value = "";
    searchResults.value = null;
    searchLoading.value = false;
    searchOpen.value = false;
  });
}
function clearChat() {
  n2(() => {
    chatMessages.value = [];
    chatStatus.value = "";
    chatLoading.value = false;
    threadId.value = null;
    channelType.value = "web";
    messagingGroupId.value = null;
    canSend.value = true;
    highlightMessageId.value = null;
  });
  if (refs.ws) {
    try {
      refs.ws.close();
    } catch {
    }
    refs.ws = null;
  }
  if (refs.reconnectTimer) {
    clearTimeout(refs.reconnectTimer);
    refs.reconnectTimer = null;
  }
  refs.seenIds.clear();
}
function startSyncPoll() {
  if (refs.syncTimer) return;
  runSync().catch(() => {
  });
  refs.syncTimer = setInterval(() => {
    if (document.hidden) return;
    runSync().catch((err) => console.error("sync failed", err));
  }, SYNC_INTERVAL_MS);
}
async function runSync() {
  const gid = groupId.value;
  const tid = threadId.value;
  const ct = channelType.value;
  const mg = messagingGroupId.value;
  const params = new URLSearchParams();
  if (gid) {
    params.set("gid", gid);
    if (tid && ct && ct !== "web" && mg) {
      params.set("tid", tid);
      params.set("channel", ct);
      params.set("mg", mg);
    }
  }
  let res;
  try {
    res = await api("api/sync" + (params.toString() ? "?" + params.toString() : ""));
  } catch {
    return;
  }
  if (Array.isArray(res.approvals)) pendingApprovals.value = res.approvals;
  if (Array.isArray(res.questions)) pendingQuestions.value = res.questions;
  if (gid && groupId.value === gid && Array.isArray(res.threads)) {
    const serverIds = new Set(res.threads.map((t4) => t4.threadId));
    const ephemeral = threads.value.filter(
      (t4) => !serverIds.has(t4.threadId) && (t4.channelType || "web") === "web" && t4.title === "(new thread)" && !t4.messageCount
    );
    threads.value = ephemeral.length > 0 ? [...ephemeral, ...res.threads] : res.threads;
  }
  if (gid && groupId.value === gid && tid && threadId.value === tid && ct === channelType.value && ct !== "web" && Array.isArray(res.threadMessages)) {
    mergeIncomingMessages(res.threadMessages);
  }
}
function mergeIncomingMessages(messages) {
  let maxTs = "";
  const additions = [];
  for (const m6 of messages) {
    const direction = normDirection(m6.direction);
    const key = m6.id ? `${direction}:${m6.id}` : null;
    if (key && refs.seenIds.has(key)) continue;
    const ts = m6.timestamp || "";
    additions.push({
      id: m6.id,
      direction,
      text: m6.text,
      files: m6.files || null,
      ts,
      ...m6.usage ? { usage: m6.usage } : {},
      ...m6.activity ? { activity: m6.activity } : {}
    });
    if (key) refs.seenIds.add(key);
    if (ts > maxTs) maxTs = ts;
    if (direction === "out") maybeNotify(m6.text, m6.files || []);
  }
  if (additions.length) {
    chatMessages.value = chatMessages.value.concat(additions);
    bumpActiveThread(maxTs);
  }
}
function historyUrl(gid, tid) {
  let u5 = `api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(tid)}/history`;
  const params = new URLSearchParams();
  const t4 = threads.value.find((x6) => x6.threadId === tid);
  const ct = t4?.channelType || channelType.value;
  const mg = t4?.messagingGroupId || messagingGroupId.value;
  if (mg && ct !== "web") {
    params.set("channel", ct);
    params.set("mg", mg);
  }
  const qs = params.toString();
  if (qs) u5 += "?" + qs;
  return u5;
}
function appendMsg(direction, text, files, ts, id, activity) {
  const key = id ? `${direction}:${id}` : null;
  if (key && refs.seenIds.has(key)) return;
  if (key) refs.seenIds.add(key);
  chatMessages.value = chatMessages.value.concat({
    id,
    direction,
    text,
    files: files || null,
    ts,
    ...activity && activity.length ? { activity } : {}
  });
}
function normDirection(d5) {
  return d5 === "in" ? "in" : d5 === "internal" ? "internal" : "out";
}
async function refetchThreadHistory(appendNewOnly) {
  const gid = groupId.value, tid = threadId.value;
  if (!gid || !tid) return;
  const r4 = await fetch(historyUrl(gid, tid), { credentials: "same-origin", cache: "no-store" });
  if (!r4.ok) return;
  const { messages, voiceMode: nextVoiceMode } = await r4.json();
  if (!Array.isArray(messages)) return;
  if (nextVoiceMode) voiceMode.value = nextVoiceMode;
  if (!appendNewOnly) {
    chatMessages.value = messages.map((m6) => ({
      id: m6.id,
      direction: normDirection(m6.direction),
      text: m6.text,
      files: m6.files || null,
      ts: m6.timestamp,
      ...m6.usage ? { usage: m6.usage } : {},
      ...m6.activity ? { activity: m6.activity } : {}
    }));
    refs.seenIds = new Set(messages.filter((m6) => m6.id).map((m6) => `${normDirection(m6.direction)}:${m6.id}`));
    return;
  }
  let maxTs = "";
  const additions = [];
  for (const m6 of messages) {
    const direction = normDirection(m6.direction);
    const key = m6.id ? `${direction}:${m6.id}` : null;
    if (key && refs.seenIds.has(key)) continue;
    const ts = m6.timestamp || "";
    additions.push({
      id: m6.id,
      direction,
      text: m6.text,
      files: m6.files || null,
      ts,
      ...m6.usage ? { usage: m6.usage } : {},
      ...m6.activity ? { activity: m6.activity } : {}
    });
    if (key) refs.seenIds.add(key);
    if (ts > maxTs) maxTs = ts;
    if (direction === "out") maybeNotify(m6.text, m6.files || []);
  }
  if (additions.length) {
    chatMessages.value = chatMessages.value.concat(additions);
    bumpActiveThread(maxTs);
  }
}
async function openChat(gid, resumeTid, opts) {
  if (resumeTid && groupId.value === gid && threadId.value === resumeTid) return;
  if (refs.ws) {
    try {
      refs.ws.close();
    } catch {
    }
    refs.ws = null;
  }
  if (refs.reconnectTimer) {
    clearTimeout(refs.reconnectTimer);
    refs.reconnectTimer = null;
  }
  refs.reconnectAttempt = 0;
  let ct = "web";
  let mg = null;
  let cs = true;
  if (opts && opts.channelType) {
    ct = opts.channelType;
    mg = opts.messagingGroupId || null;
    cs = !!opts.canSend;
  } else if (resumeTid) {
    const t4 = threads.value.find((x6) => x6.threadId === resumeTid);
    if (t4 && t4.channelType && t4.channelType !== "web") {
      ct = t4.channelType;
      mg = t4.messagingGroupId || null;
      cs = !!t4.canSend;
    }
  }
  n2(() => {
    groupId.value = gid;
    chatMessages.value = [];
    channelType.value = ct;
    messagingGroupId.value = mg;
    canSend.value = ct === "web" ? true : cs;
    isTyping.value = false;
    typingHint.value = "";
    activityLog.value = [];
    if (resumeTid) {
      threadId.value = resumeTid;
      chatLoading.value = true;
      chatStatus.value = "loading history\u2026";
    }
  });
  if (resumeTid) {
    writeHash();
    try {
      const r4 = await fetch(historyUrl(gid, resumeTid), { credentials: "same-origin", cache: "no-store" });
      if (r4.ok) {
        const data = await r4.json();
        const messages = data.messages;
        n2(() => {
          chatMessages.value = (messages || []).map((m6) => ({
            id: m6.id,
            direction: normDirection(m6.direction),
            text: m6.text,
            files: m6.files || null,
            ts: m6.timestamp,
            ...m6.usage ? { usage: m6.usage } : {},
            ...m6.activity ? { activity: m6.activity } : {}
          }));
          chatLoading.value = false;
          voiceMode.value = data.voiceMode || "off";
        });
        if (Array.isArray(messages)) {
          refs.seenIds = new Set(messages.filter((m6) => m6.id).map((m6) => `${normDirection(m6.direction)}:${m6.id}`));
        }
      } else {
        chatLoading.value = false;
      }
    } catch (err) {
      console.error("history load failed", err);
      chatLoading.value = false;
    }
    if (ct === "web") connectChatWs();
    else {
      chatStatus.value = "";
    }
    if (!highlightMessageId.value) focusComposerSoon();
    return;
  }
  const empty = threads.value.find(
    (t4) => (t4.channelType || "web") === "web" && t4.title === "(new thread)" && !t4.messageCount
  );
  if (empty) {
    threadId.value = empty.threadId;
    writeHash();
    connectChatWs();
    focusComposerSoon();
    return;
  }
  if (refs.newChatInFlight) return;
  refs.newChatInFlight = true;
  n2(() => {
    channelType.value = "web";
    messagingGroupId.value = null;
    canSend.value = true;
  });
  chatStatus.value = "starting\u2026";
  let started;
  try {
    const r4 = await fetch(`api/groups/${encodeURIComponent(gid)}/chat/start`, {
      method: "POST",
      credentials: "same-origin"
    });
    if (!r4.ok) throw new Error("HTTP " + r4.status);
    started = await r4.json();
  } catch (err) {
    const m6 = err instanceof Error ? err.message : String(err);
    chatStatus.value = "failed to start chat: " + m6;
    refs.newChatInFlight = false;
    return;
  }
  threadId.value = started.threadId;
  threads.value = [
    {
      threadId: started.threadId,
      sessionId: started.sessionId || null,
      channelType: "web",
      messagingGroupId: started.messagingGroupId || null,
      sessionMode: started.sessionMode || "per-thread",
      title: "(new thread)",
      lastActivityAt: (/* @__PURE__ */ new Date()).toISOString(),
      messageCount: 0
    },
    ...threads.value
  ];
  writeHash();
  connectChatWs();
  focusComposerSoon();
  refs.newChatInFlight = false;
}
function connectChatWs() {
  if (!groupId.value || !threadId.value) return;
  const gid = groupId.value, tid = threadId.value;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/ui/chat/api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(tid)}/ws`;
  const ws = new WebSocket(wsUrl);
  refs.ws = ws;
  ws.onopen = () => {
    const wasReconnect = refs.reconnectAttempt > 0;
    refs.reconnectAttempt = 0;
    chatStatus.value = "connected";
    if (refs.wsPingTimer) clearInterval(refs.wsPingTimer);
    refs.wsPingTimer = setInterval(() => {
      if (refs.ws !== ws) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send('{"kind":"ping"}');
      } catch {
      }
    }, 25e3);
    if (wasReconnect) {
      refetchThreadHistory(true).catch((err) => console.error("reconnect catchup failed", err));
    }
  };
  ws.onclose = () => {
    if (refs.ws !== ws) return;
    refs.ws = null;
    if (refs.wsPingTimer) {
      clearInterval(refs.wsPingTimer);
      refs.wsPingTimer = null;
    }
    isTyping.value = false;
    typingHint.value = "";
    activityLog.value = [];
    if (groupId.value !== gid || threadId.value !== tid) return;
    const attempt = ++refs.reconnectAttempt;
    const delay = Math.min(15e3, 500 * Math.pow(2, attempt - 1));
    chatStatus.value = `disconnected \xB7 reconnecting in ${Math.round(delay / 1e3)}s\u2026`;
    refs.reconnectTimer = setTimeout(() => {
      refs.reconnectTimer = null;
      if (groupId.value === gid && threadId.value === tid) connectChatWs();
    }, delay);
  };
  ws.onerror = () => {
    chatStatus.value = "connection error";
  };
  ws.onmessage = (ev) => {
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (payload.kind === "ready") return;
    if (payload.kind === "typing") {
      isTyping.value = !!payload.on;
      typingHint.value = payload.hint || "";
      if (!payload.on) {
        if (activityLog.value.length) refs.carryActivity = activityLog.value.slice();
        activityLog.value = [];
      } else if (payload.items && payload.items.length) {
        const prev = activityLog.value;
        const merged = prev.concat(payload.items);
        activityLog.value = merged.length > 200 ? merged.slice(merged.length - 200) : merged;
        playProgressTick();
      }
      return;
    }
    if (payload.kind === "inbound") {
      refs.carryActivity = [];
      appendMsg("in", payload.text || "", payload.files || null, payload.timestamp || "", payload.id);
      updateActiveThreadTitleFromFirstMessage(payload.text || "");
      bumpActiveThread();
      return;
    }
    if (payload.kind === "outbound") {
      if (payload.messageKind === "chat-sdk") {
        if (payload.question) {
          const q5 = {
            questionId: payload.question.questionId,
            title: payload.question.title,
            question: payload.question.title,
            options: payload.question.options,
            threadId: threadId.value,
            agentGroupId: groupId.value || "",
            createdAt: payload.timestamp || (/* @__PURE__ */ new Date()).toISOString()
          };
          const existing = pendingQuestions.value;
          if (!existing.some((e4) => e4.questionId === q5.questionId)) {
            pendingQuestions.value = [...existing, q5];
          }
          isTyping.value = false;
          typingHint.value = "";
          activityLog.value = [];
        } else {
          const c5 = payload.content || {};
          const text2 = typeof c5 === "string" ? c5 : c5.fallbackText || "";
          if (text2) {
            appendMsg("out", text2, payload.files || [], payload.timestamp || "", payload.id);
            bumpActiveThread();
          }
        }
        return;
      }
      const c4 = payload.content || {};
      const text = typeof c4 === "string" ? c4 : c4.text || c4.markdown || "";
      const dir = payload.messageKind === "internal" ? "internal" : "out";
      const carriedActivity = dir === "out" ? activityLog.value.length ? activityLog.value.slice() : refs.carryActivity : null;
      appendMsg(dir, text, payload.files || [], payload.timestamp || "", payload.id, carriedActivity);
      bumpActiveThread();
      if (dir === "out") {
        activityLog.value = [];
        refs.carryActivity = [];
        playCompletionChime();
        maybeNotify(text, payload.files || []);
      }
      return;
    }
    if (payload.kind === "usage") {
      const mid = payload.id;
      const usage = payload.usage;
      if (!mid || !usage) return;
      const list = chatMessages.value;
      let changed = false;
      const next = list.map((m6) => {
        if (m6.id === mid && m6.direction === "out") {
          changed = true;
          return { ...m6, usage };
        }
        return m6;
      });
      if (changed) chatMessages.value = next;
      return;
    }
  };
}
async function sendChat(text, files) {
  if (!groupId.value || !threadId.value) return;
  refs.carryActivity = [];
  requestScrollToBottom();
  const isWeb = !channelType.value || channelType.value === "web";
  const hasFiles = Array.isArray(files) && files.length > 0;
  if (!isWeb) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const fileMetas = hasFiles ? files.map((f5) => ({ filename: f5.name, size: f5.size })) : null;
    appendMsg("in", text || "", fileMetas, now);
  }
  let url = `api/groups/${encodeURIComponent(groupId.value)}/chat/${encodeURIComponent(threadId.value)}/send`;
  if (!isWeb && messagingGroupId.value) {
    url += `?channel=${encodeURIComponent(channelType.value)}&mg=${encodeURIComponent(messagingGroupId.value)}`;
  }
  try {
    let res;
    if (hasFiles) {
      const fd = new FormData();
      fd.append("text", text || "");
      for (const f5 of files) {
        if (f5.file) fd.append("file", f5.file, f5.name);
      }
      res = await fetch(url, { method: "POST", credentials: "same-origin", body: fd });
    } else {
      res = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j6 = await res.json();
        if (j6 && j6.error) detail = j6.error + (j6.detail ? ` (${j6.detail})` : "");
      } catch {
      }
      chatStatus.value = `send failed: ${detail}`;
    } else if (!isWeb) {
      try {
        await refetchThreadHistory(false);
      } catch {
      }
    }
  } catch (err) {
    console.error("send failed", err);
    const m6 = err instanceof Error ? err.message : "network error";
    chatStatus.value = `send failed: ${m6}`;
  }
}
async function selectGroup(gid) {
  clearChat();
  n2(() => {
    groupId.value = gid;
    treePath.value = "";
    filePath.value = null;
  });
  clearSearch();
  await loadThreads(gid);
  await loadTree("");
  const latest = threads.value.length > 0 ? threads.value[0] : null;
  if (latest) {
    openChat(gid, latest.threadId, threadCtxOf(latest)).catch((err) => console.error("chat open failed", err));
  } else {
    openChat(gid, null, null).catch((err) => console.error("auto-start chat failed", err));
  }
}
async function loadTree(p5) {
  n2(() => {
    treePath.value = p5;
    filePath.value = null;
    previewBlock.value = null;
    treeError.value = "";
    treeEntries.value = [];
  });
  try {
    if (!groupId.value) return;
    const segs = String(p5 || "").split("/").filter(Boolean).map(encodeURIComponent);
    const url = `api/groups/${encodeURIComponent(groupId.value)}/dirs/${segs.length ? segs.join("/") + "/" : ""}`;
    const { entries } = await api(url);
    treeEntries.value = entries || [];
  } catch (err) {
    const msg = /HTTP 404/.test(String(err && err.message)) ? "Not found. It may have been renamed or deleted." : String(err?.message || err);
    treeError.value = msg;
  }
}
async function navTree(p5) {
  await loadTree(p5);
  writeHash();
}
async function navFile(entry) {
  if (isMobile.value) drawerOpen.files.value = true;
  else paneOpen.files.value = true;
  const parent = parentPath(entry.path);
  if (treePath.value !== parent) await loadTree(parent);
  await selectFile(entry);
  writeHash();
}
async function selectFile(entry) {
  filePath.value = entry.path;
  if (!groupId.value) return;
  const segs = String(entry.path || "").split("/").filter(Boolean).map(encodeURIComponent);
  const url = `api/groups/${encodeURIComponent(groupId.value)}/files/${segs.join("/")}`;
  let size = entry.size;
  let mtime = entry.mtime;
  try {
    const h5 = await fetch(url, { method: "HEAD", credentials: "same-origin" });
    if (h5.status >= 400) {
      const msg = h5.status === 404 ? "File not found. It may have been renamed or deleted." : `HTTP ${h5.status}`;
      previewBlock.value = { kind: "error", text: msg, name: entry.name, url };
      return;
    }
    if (size == null) {
      const cl = h5.headers.get("content-length");
      if (cl) size = Number(cl);
    }
    if (!mtime) {
      const lm = h5.headers.get("last-modified");
      if (lm) {
        const t4 = Date.parse(lm);
        if (t4) mtime = new Date(t4).toISOString();
      }
    }
  } catch {
  }
  const ext = entry.name.toLowerCase().split(".").pop() || "";
  const meta = { name: entry.name, size: size ?? null, mtime: mtime ?? null, url, path: entry.path };
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) previewBlock.value = { kind: "image", ...meta };
  else if (["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba"].includes(ext))
    previewBlock.value = { kind: "audio", ...meta };
  else if (["mp4", "m4v", "mov", "webm", "ogv"].includes(ext)) previewBlock.value = { kind: "video", ...meta };
  else if (ext === "pdf") previewBlock.value = { kind: "pdf", ...meta };
  else {
    try {
      const r4 = await fetch(url, { credentials: "same-origin" });
      if (!r4.ok) {
        previewBlock.value = { kind: "error", text: `HTTP ${r4.status}`, ...meta };
        return;
      }
      const ctType = r4.headers.get("content-type") || "";
      if (ctType.startsWith("text/") || ctType.includes("json") || ctType.includes("xml")) {
        const txt = await r4.text();
        const isMd = ext === "md" || ext === "markdown";
        previewBlock.value = { kind: isMd ? "markdown" : "text", text: txt, ...meta };
      } else {
        previewBlock.value = { kind: "binary", mime: ctType, ...meta };
      }
    } catch (err) {
      previewBlock.value = { kind: "error", text: String(err?.message || err), ...meta };
    }
  }
  fetchAndAttachMeta(entry.path).catch(() => {
  });
}
async function fetchAndAttachMeta(p5) {
  const gid = groupId.value;
  if (!gid) return;
  const segs = String(p5 || "").split("/").filter(Boolean).map(encodeURIComponent);
  const u5 = `api/groups/${encodeURIComponent(gid)}/files/${segs.join("/")}?meta=1`;
  const r4 = await fetch(u5, { credentials: "same-origin", cache: "no-store" });
  if (!r4.ok) return;
  const data = await r4.json();
  const cur = previewBlock.value;
  if (!cur || cur.path !== p5) return;
  const next = {
    ...cur,
    tags: data.tags || null,
    lyrics: data.lyrics || null,
    mime: data.mime || cur.mime,
    size: data.size ?? cur.size,
    mtime: data.mtime || cur.mtime
  };
  previewBlock.value = next;
}
function closePreview() {
  n2(() => {
    filePath.value = null;
    previewBlock.value = null;
  });
  writeHash();
}
function togglePinnedFile(path) {
  if (!path) return;
  const cur = pinnedContext.value;
  pinnedContext.value = cur.includes(path) ? cur.filter((p5) => p5 !== path) : cur.concat(path);
}
function removePinnedPath(path) {
  pinnedContext.value = pinnedContext.value.filter((p5) => p5 !== path);
}
function clearPinnedContext() {
  pinnedContext.value = [];
}
function addPendingFiles(fileList, max, maxSize, maxTotal) {
  if (!fileList || fileList.length === 0) return;
  const next = pending.value.slice();
  let totalBytes = next.reduce((n3, f5) => n3 + f5.size, 0);
  for (const f5 of Array.from(fileList)) {
    if (next.length >= max) {
      chatStatus.value = `max ${max} files per message`;
      break;
    }
    if (f5.size > maxSize) {
      chatStatus.value = `${f5.name} too large (max ${(maxSize / 1024 / 1024).toFixed(0)} MB)`;
      continue;
    }
    if (totalBytes + f5.size > maxTotal) {
      chatStatus.value = `total upload too large (max ${(maxTotal / 1024 / 1024).toFixed(0)} MB)`;
      break;
    }
    next.push({ name: f5.name, size: f5.size, file: f5 });
    totalBytes += f5.size;
  }
  pending.value = next;
}
function removePending(i5) {
  const next = pending.value.slice();
  next.splice(i5, 1);
  pending.value = next;
}
function clearPending() {
  pending.value = [];
}
var NOW_TICK_MS = 3e4;
function installLivenessHandlers() {
  setInterval(() => {
    if (!document.hidden) nowTick.value = Date.now();
  }, NOW_TICK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    nowTick.value = Date.now();
    runSync().catch(() => {
    });
    if (!threadId.value) return;
    refetchThreadHistory(true).catch((err) => console.error("resume catchup failed", err));
    const ws = refs.ws;
    const open = !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
    if (channelType.value === "web" && !open) {
      if (refs.reconnectTimer) {
        clearTimeout(refs.reconnectTimer);
        refs.reconnectTimer = null;
      }
      connectChatWs();
    }
  });
}
async function respondApproval(approvalId, value) {
  if (respondingApprovalIds.value.has(approvalId)) return;
  const next = new Set(respondingApprovalIds.value);
  next.add(approvalId);
  respondingApprovalIds.value = next;
  const before = pendingApprovals.value;
  pendingApprovals.value = before.filter((a4) => a4.approvalId !== approvalId);
  const verb = value === "approve" ? "Approving" : value === "reject" ? "Rejecting" : "Submitting";
  chatStatus.value = verb + "\u2026";
  try {
    const res = await postJson(
      `api/approvals/${encodeURIComponent(approvalId)}/respond`,
      { value }
    );
    if (!res.ok) throw new Error(res.data?.error || "HTTP " + res.status);
    chatStatus.value = verb.replace(/ing$/, "ed") + " \u2014 applied";
    setTimeout(() => {
      if (chatStatus.value.startsWith("Approved") || chatStatus.value.startsWith("Rejected") || chatStatus.value.startsWith("Submitted")) {
        chatStatus.value = "";
      }
    }, 4e3);
  } catch (err) {
    console.error("approval respond failed", err);
    chatStatus.value = "approval failed: " + (err instanceof Error ? err.message : String(err));
    runSync().catch(() => {
    });
  } finally {
    const cleared = new Set(respondingApprovalIds.value);
    cleared.delete(approvalId);
    respondingApprovalIds.value = cleared;
  }
}
async function respondQuestion(questionId, value) {
  if (respondingQuestionIds.value.has(questionId)) return;
  const next = new Set(respondingQuestionIds.value);
  next.add(questionId);
  respondingQuestionIds.value = next;
  pendingQuestions.value = pendingQuestions.value.filter((q5) => q5.questionId !== questionId);
  try {
    const res = await postJson(
      `api/approvals/${encodeURIComponent(questionId)}/respond`,
      { value }
    );
    if (!res.ok) throw new Error(res.data?.error || "HTTP " + res.status);
  } catch (err) {
    console.error("question respond failed", err);
    chatStatus.value = "response failed: " + (err instanceof Error ? err.message : String(err));
    setTimeout(() => {
      if (chatStatus.value.startsWith("response failed")) chatStatus.value = "";
    }, 4e3);
    runSync().catch(() => {
    });
  } finally {
    const cleared = new Set(respondingQuestionIds.value);
    cleared.delete(questionId);
    respondingQuestionIds.value = cleared;
  }
}

// src/components/CreateGroupModal.tsx
var createGroupOpen = y3(false);
function errMsg(data, fallback) {
  if (data && typeof data === "object") {
    const obj = data;
    if (typeof obj.message === "string" && obj.message) return obj.message;
    if (typeof obj.error === "string" && obj.error) return obj.error;
  }
  return fallback;
}
function CreateGroupModal() {
  const open = createGroupOpen.value;
  const [name, setName] = h2("");
  const [folder, setFolder] = h2("");
  const [instructions, setInstructions] = h2("");
  const [submitting, setSubmitting] = h2(false);
  const nameRef = A2(null);
  y2(() => {
    if (!open) return;
    setName("");
    setFolder("");
    setInstructions("");
    setSubmitting(false);
    requestAnimationFrame(() => nameRef.current?.focus());
  }, [open]);
  if (!open) return null;
  function close() {
    createGroupOpen.value = false;
  }
  async function onSubmit(e4) {
    e4.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    const r4 = await postJson("api/groups", {
      name: trimmed,
      folder: folder.trim() || void 0,
      instructions: instructions || void 0
    });
    if (!r4.ok) {
      showToast(errMsg(r4.data, `HTTP ${r4.status}`), "err");
      setSubmitting(false);
      return;
    }
    const created = {
      id: r4.data.id,
      name: r4.data.name,
      isAdmin: true,
      hasContent: true,
      lastActivityAt: r4.data.createdAt
    };
    groups.value = [created, ...groups.value.filter((g8) => g8.id !== created.id)];
    close();
    showToast(`Created "${created.name}"`);
    selectGroup(created.id).catch((err) => console.error("selectGroup after create", err));
  }
  function onBackdrop(e4) {
    if (e4.target.classList.contains("settings-backdrop")) close();
  }
  function onKey(e4) {
    if (e4.key === "Escape") close();
  }
  return /* @__PURE__ */ u4("div", { class: "settings-backdrop", onClick: onBackdrop, children: /* @__PURE__ */ u4(
    "form",
    {
      class: "settings-modal",
      role: "dialog",
      "aria-label": "Create agent group",
      style: "max-width:480px",
      onSubmit,
      onKeyDown: onKey,
      children: [
        /* @__PURE__ */ u4("header", { class: "settings-head", children: [
          /* @__PURE__ */ u4("span", { class: "title", children: "New agent group" }),
          /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: close, children: "\u2715" })
        ] }),
        /* @__PURE__ */ u4("div", { class: "settings-body create-group-body", children: [
          /* @__PURE__ */ u4("label", { class: "cg-field", children: [
            /* @__PURE__ */ u4("span", { class: "cg-label", children: "Name" }),
            /* @__PURE__ */ u4(
              "input",
              {
                ref: nameRef,
                type: "text",
                value: name,
                required: true,
                placeholder: "e.g. Research Helper",
                onInput: (e4) => setName(e4.currentTarget.value)
              }
            )
          ] }),
          /* @__PURE__ */ u4("label", { class: "cg-field", children: [
            /* @__PURE__ */ u4("span", { class: "cg-label", children: [
              "Folder ",
              /* @__PURE__ */ u4("span", { class: "cg-optional", children: "(optional \u2014 derived from name)" })
            ] }),
            /* @__PURE__ */ u4(
              "input",
              {
                type: "text",
                value: folder,
                placeholder: "research-helper",
                onInput: (e4) => setFolder(e4.currentTarget.value)
              }
            )
          ] }),
          /* @__PURE__ */ u4("label", { class: "cg-field", children: [
            /* @__PURE__ */ u4("span", { class: "cg-label", children: [
              "Initial instructions ",
              /* @__PURE__ */ u4("span", { class: "cg-optional", children: "(optional)" })
            ] }),
            /* @__PURE__ */ u4(
              "textarea",
              {
                value: instructions,
                rows: 5,
                placeholder: "What should this agent know or do?",
                onInput: (e4) => setInstructions(e4.currentTarget.value)
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ u4(
          "footer",
          {
            class: "settings-foot",
            style: "display:flex;justify-content:flex-end;gap:8px;padding:8px 12px;border-top:1px solid var(--border)",
            children: [
              /* @__PURE__ */ u4("button", { type: "button", onClick: close, disabled: submitting, children: "Cancel" }),
              /* @__PURE__ */ u4("button", { type: "submit", class: "primary", disabled: submitting || !name.trim(), children: submitting ? "Creating\u2026" : "Create" })
            ]
          }
        )
      ]
    }
  ) });
}

// src/components/TabBar.tsx
function TabBar(props) {
  const { ariaLabel, activeId, items, onSelect, extras, className, mobileSheetTitle } = props;
  const navRef = A2(null);
  const [sheetOpen, setSheetOpen] = h2(false);
  y2(() => {
    const nav2 = navRef.current;
    if (!nav2) return;
    const el = nav2.querySelector('[aria-selected="true"]');
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);
  y2(() => {
    if (!sheetOpen) return;
    const onKey = (e4) => {
      if (e4.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);
  const activeItem = items.find((it) => it.id === activeId) ?? null;
  const dropdownLabel = activeItem?.label ?? "";
  const sheetTitle = mobileSheetTitle ?? ariaLabel;
  const cls = (base) => className ? `${base} ${className}` : base;
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4(
      "nav",
      {
        ref: navRef,
        class: cls("tab-bar-strip"),
        role: "tablist",
        "aria-label": ariaLabel,
        children: [
          items.map((it) => {
            const isActive = it.id === activeId;
            return /* @__PURE__ */ u4(
              "button",
              {
                type: "button",
                role: "tab",
                "aria-selected": isActive,
                title: it.title,
                class: `tab-item${isActive ? " active" : ""}${it.className ? ` ${it.className}` : ""}`,
                onClick: () => onSelect(it.id),
                children: [
                  /* @__PURE__ */ u4("span", { class: "tab-item-label", children: it.label }),
                  it.sublabel ? /* @__PURE__ */ u4("span", { class: "tab-item-sublabel", children: it.sublabel }) : null
                ]
              },
              it.id
            );
          }),
          extras?.map((ex) => /* @__PURE__ */ u4(
            "button",
            {
              type: "button",
              title: ex.title,
              "aria-haspopup": ex.ariaHaspopup,
              class: `tab-item tab-extra${ex.className ? ` ${ex.className}` : ""}`,
              onClick: ex.onClick,
              children: [
                /* @__PURE__ */ u4("span", { class: "tab-item-label", children: ex.label }),
                ex.sublabel ? /* @__PURE__ */ u4("span", { class: "tab-item-sublabel", children: ex.sublabel }) : null
              ]
            },
            ex.key
          ))
        ]
      }
    ),
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: cls("tab-bar-dropdown"),
        "aria-label": ariaLabel,
        "aria-haspopup": "dialog",
        "aria-expanded": sheetOpen,
        onClick: () => setSheetOpen(true),
        children: [
          /* @__PURE__ */ u4("span", { class: "tab-bar-dropdown-label", children: dropdownLabel }),
          /* @__PURE__ */ u4("span", { class: "tab-bar-dropdown-caret", "aria-hidden": "true", children: "\u25BE" })
        ]
      }
    ),
    sheetOpen ? /* @__PURE__ */ u4(
      TabBarSheet,
      {
        title: sheetTitle,
        items,
        extras,
        activeId,
        onSelect: (id) => {
          setSheetOpen(false);
          onSelect(id);
        },
        onExtra: (ex) => {
          setSheetOpen(false);
          ex.onClick();
        },
        onClose: () => setSheetOpen(false)
      }
    ) : null
  ] });
}
function TabBarSheet(props) {
  const { title, items, extras, activeId, onSelect, onExtra, onClose } = props;
  const onBackdrop = (e4) => {
    if (e4.target.classList.contains("settings-backdrop")) onClose();
  };
  return /* @__PURE__ */ u4("div", { class: "settings-backdrop tab-bar-sheet-backdrop", onClick: onBackdrop, children: /* @__PURE__ */ u4(
    "div",
    {
      class: "settings-modal tab-bar-sheet",
      role: "dialog",
      "aria-label": title,
      style: "max-width:480px",
      children: [
        /* @__PURE__ */ u4("header", { class: "settings-head", children: [
          /* @__PURE__ */ u4("span", { class: "title", children: title }),
          /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: onClose, children: "\u2715" })
        ] }),
        /* @__PURE__ */ u4("div", { class: "settings-body tab-bar-sheet-list", children: [
          items.map((it) => {
            const isActive = it.id === activeId;
            return /* @__PURE__ */ u4(
              "button",
              {
                type: "button",
                class: `tab-bar-sheet-row${isActive ? " active" : ""}${it.className ? ` ${it.className}` : ""}`,
                "aria-current": isActive ? "true" : void 0,
                title: it.title,
                onClick: () => onSelect(it.id),
                children: [
                  /* @__PURE__ */ u4("span", { class: "tab-bar-sheet-row-name", children: it.label }),
                  it.sublabel ? /* @__PURE__ */ u4("span", { class: "tab-bar-sheet-row-sub", children: it.sublabel }) : null
                ]
              },
              it.id
            );
          }),
          extras?.length ? /* @__PURE__ */ u4(k, { children: [
            /* @__PURE__ */ u4("div", { class: "tab-bar-sheet-divider", "aria-hidden": "true" }),
            extras.map((ex) => /* @__PURE__ */ u4(
              "button",
              {
                type: "button",
                class: `tab-bar-sheet-row tab-bar-sheet-extra${ex.className ? ` ${ex.className}` : ""}`,
                title: ex.title,
                onClick: () => onExtra(ex),
                children: /* @__PURE__ */ u4("span", { class: "tab-bar-sheet-row-name", children: ex.label })
              },
              ex.key
            ))
          ] }) : null
        ] })
      ]
    }
  ) });
}

// src/components/GroupPicker.tsx
function isNonMember(g8) {
  return g8.hasContent === false;
}
function chipParts(g8, elevated) {
  const isAdminOnly = elevated && isNonMember(g8);
  const parts = [];
  if (!g8.isAdmin) parts.push("\u{1F512}");
  if (isAdminOnly) parts.push("\u{1F441}");
  if (g8.lastActivityAt) parts.push(fmtRelative(g8.lastActivityAt));
  return { parts, isAdminOnly };
}
function tipFor(g8, isAdminOnly) {
  const parts = [g8.name];
  if (isAdminOnly) parts.push("Visible to you as admin");
  if (g8.lastActivityAt) parts.push(fmtAbsolute(g8.lastActivityAt));
  return parts.join(" \xB7 ");
}
function openModal(mode) {
  groupPickerMode.value = mode;
  groupPickerOpen.value = true;
}
function GroupStrip() {
  const elevated = isElevatedUser.value;
  nowTick.value;
  const all = groups.value;
  const memberGroups = all.filter((g8) => !isNonMember(g8));
  const active = all.find((g8) => g8.id === groupId.value);
  const hasActiveNonMember = active && isNonMember(active);
  const stripGroups = hasActiveNonMember ? [...memberGroups, active] : memberGroups;
  const items = stripGroups.map((g8) => {
    const { parts, isAdminOnly } = chipParts(g8, elevated);
    const sublabel = parts.join(" \xB7 ");
    return {
      id: g8.id,
      label: g8.name,
      sublabel: sublabel || void 0,
      title: tipFor(g8, isAdminOnly),
      className: isAdminOnly ? "is-admin-visible" : void 0
    };
  });
  const extras = [];
  if (elevated) {
    extras.push({
      key: "new",
      label: "New Agent\u2026",
      sublabel: "\xA0",
      title: "Create a new agent group",
      ariaHaspopup: "dialog",
      onClick: () => {
        createGroupOpen.value = true;
      },
      className: "group-extra-new"
    });
  }
  const pick = (gid) => {
    if (gid !== groupId.value) selectGroup(gid).catch(console.error);
  };
  return /* @__PURE__ */ u4(
    TabBar,
    {
      ariaLabel: "Agent groups",
      mobileSheetTitle: "Agent groups",
      activeId: active?.id ?? null,
      items,
      onSelect: pick,
      extras: extras.length ? extras : void 0,
      className: "group-strip"
    }
  );
}
function MoreAgentsButton() {
  const elevated = isElevatedUser.value;
  const all = groups.value;
  if (!elevated) return null;
  const nonMemberCount = all.filter(isNonMember).length;
  if (nonMemberCount === 0) return null;
  const tip = `Groups belonging to other users (${nonMemberCount})`;
  return /* @__PURE__ */ u4(
    "button",
    {
      type: "button",
      class: "icon-btn more-agents-btn",
      "aria-label": tip,
      title: tip,
      "aria-haspopup": "dialog",
      onClick: () => openModal("non-members"),
      children: "\u{1F441}\uFE0F"
    }
  );
}
function GroupPickerModal() {
  const open = groupPickerOpen.value;
  const mode = groupPickerMode.value;
  nowTick.value;
  y2(() => {
    if (!open) return;
    const onKey = (e4) => {
      if (e4.key === "Escape") groupPickerOpen.value = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  const elevated = isElevatedUser.value;
  const all = groups.value;
  const visible = (() => {
    if (mode === "non-members") return all.filter(isNonMember);
    return elevated ? all : all.filter((g8) => !isNonMember(g8));
  })();
  const title = mode === "non-members" ? "More agents" : "Agent groups";
  const close = () => {
    groupPickerOpen.value = false;
  };
  const onBackdrop = (e4) => {
    if (e4.target.classList.contains("settings-backdrop")) close();
  };
  const pick = (gid) => {
    close();
    if (gid !== groupId.value) selectGroup(gid).catch(console.error);
  };
  return /* @__PURE__ */ u4("div", { class: "settings-backdrop", onClick: onBackdrop, children: /* @__PURE__ */ u4(
    "div",
    {
      class: "settings-modal group-picker-modal",
      role: "dialog",
      "aria-label": title,
      style: "max-width:480px",
      children: [
        /* @__PURE__ */ u4("header", { class: "settings-head", children: [
          /* @__PURE__ */ u4("span", { class: "title", children: title }),
          /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: close, children: "\u2715" })
        ] }),
        /* @__PURE__ */ u4("div", { class: "settings-body group-picker-list", children: visible.map((g8) => {
          const isActive = g8.id === groupId.value;
          const { parts, isAdminOnly } = chipParts(g8, elevated);
          const subtitle = parts.join(" \xB7 ");
          return /* @__PURE__ */ u4(
            "button",
            {
              type: "button",
              class: `group-row${isActive ? " active" : ""}${isAdminOnly ? " is-admin-visible" : ""}`,
              "aria-current": isActive ? "true" : void 0,
              title: tipFor(g8, isAdminOnly),
              onClick: () => pick(g8.id),
              children: [
                /* @__PURE__ */ u4("span", { class: "row-name", children: g8.name }),
                subtitle ? /* @__PURE__ */ u4("span", { class: "row-sub", children: subtitle }) : null
              ]
            },
            g8.id
          );
        }) })
      ]
    }
  ) });
}

// src/components/Header.tsx
function Header() {
  const admin = isAdmin.value;
  return /* @__PURE__ */ u4("header", { children: [
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "icon-btn mobile-only",
        "aria-label": "Threads",
        onClick: () => {
          drawerOpen.threads.value = !drawerOpen.threads.value;
          drawerOpen.files.value = false;
        },
        children: "\u2630"
      }
    ),
    /* @__PURE__ */ u4("span", { class: "brand", children: BRAND.name }),
    /* @__PURE__ */ u4(GroupStrip, {}),
    /* @__PURE__ */ u4(MoreAgentsButton, {}),
    admin ? /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "icon-btn",
        "aria-label": "Group admin",
        title: "Group admin",
        onClick: () => {
          groupAdminOpen.value = !groupAdminOpen.value;
        },
        children: "\u2699\uFE0F"
      }
    ) : null,
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "icon-btn",
        "aria-label": "Settings",
        title: "Settings",
        onClick: () => {
          settingsOpen.value = !settingsOpen.value;
        },
        children: "\u{1F464}"
      }
    ),
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "icon-btn mobile-only",
        "aria-label": "Files",
        onClick: () => {
          drawerOpen.files.value = !drawerOpen.files.value;
          drawerOpen.threads.value = false;
        },
        children: "\u{1F4C1}"
      }
    )
  ] });
}

// src/components/PromptModal.tsx
var promptRequest = y3(null);
function requestInput(opts) {
  return new Promise((resolve) => {
    promptRequest.value = { ...opts, resolve };
  });
}
function PromptModal() {
  const req = promptRequest.value;
  const [value, setValue] = h2("");
  const inputRef = A2(null);
  y2(() => {
    if (!req) return;
    setValue(req.initialValue || "");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [req]);
  if (!req) return null;
  function close(result) {
    const r4 = promptRequest.value;
    promptRequest.value = null;
    r4?.resolve(result);
  }
  function onSubmit(e4) {
    e4.preventDefault();
    const trimmed = value.trim();
    close(trimmed ? trimmed : null);
  }
  function onBackdrop(e4) {
    if (e4.target.classList.contains("settings-backdrop")) close(null);
  }
  function onKey(e4) {
    if (e4.key === "Escape") close(null);
  }
  return /* @__PURE__ */ u4("div", { class: "settings-backdrop", onClick: onBackdrop, children: /* @__PURE__ */ u4(
    "form",
    {
      class: "settings-modal",
      role: "dialog",
      "aria-label": req.title,
      style: "max-width:420px",
      onSubmit,
      children: [
        /* @__PURE__ */ u4("header", { class: "settings-head", children: [
          /* @__PURE__ */ u4("span", { class: "title", children: req.title }),
          /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: () => close(null), children: "\u2715" })
        ] }),
        /* @__PURE__ */ u4("div", { class: "settings-body", children: [
          req.label ? /* @__PURE__ */ u4("label", { style: "display:block;margin-bottom:6px;font-size:12px;color:var(--muted)", children: req.label }) : null,
          /* @__PURE__ */ u4(
            "input",
            {
              ref: inputRef,
              type: "text",
              value,
              placeholder: req.placeholder || "",
              onInput: (e4) => setValue(e4.currentTarget.value),
              onKeyDown: onKey,
              style: "width:100%"
            }
          )
        ] }),
        /* @__PURE__ */ u4("footer", { class: "settings-foot", style: "display:flex;justify-content:flex-end;gap:8px;padding:8px 12px;border-top:1px solid var(--border)", children: [
          /* @__PURE__ */ u4("button", { type: "button", onClick: () => close(null), children: "Cancel" }),
          /* @__PURE__ */ u4("button", { type: "submit", class: "primary", children: req.okLabel || "OK" })
        ] })
      ]
    }
  ) });
}
var confirmRequest = y3(null);
function requestConfirm(opts) {
  return new Promise((resolve) => {
    confirmRequest.value = { ...opts, resolve };
  });
}
function ConfirmModal() {
  const req = confirmRequest.value;
  const okRef = A2(null);
  y2(() => {
    if (!req) return;
    requestAnimationFrame(() => okRef.current?.focus());
  }, [req]);
  if (!req) return null;
  function close(result) {
    const r4 = confirmRequest.value;
    confirmRequest.value = null;
    r4?.resolve(result);
  }
  function onBackdrop(e4) {
    if (e4.target.classList.contains("settings-backdrop")) close(false);
  }
  function onKey(e4) {
    if (e4.key === "Escape") close(false);
    else if (e4.key === "Enter") close(true);
  }
  return /* @__PURE__ */ u4("div", { class: "settings-backdrop", onClick: onBackdrop, onKeyDown: onKey, tabIndex: -1, children: /* @__PURE__ */ u4(
    "div",
    {
      class: "settings-modal",
      role: "alertdialog",
      "aria-label": req.title,
      style: "max-width:420px",
      children: [
        /* @__PURE__ */ u4("header", { class: "settings-head", children: [
          /* @__PURE__ */ u4("span", { class: "title", children: req.title }),
          /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: () => close(false), children: "\u2715" })
        ] }),
        /* @__PURE__ */ u4("div", { class: "settings-body", style: "white-space:pre-wrap", children: req.message }),
        /* @__PURE__ */ u4("footer", { class: "settings-foot", style: "display:flex;justify-content:flex-end;gap:8px;padding:8px 12px;border-top:1px solid var(--border)", children: [
          /* @__PURE__ */ u4("button", { type: "button", onClick: () => close(false), children: req.cancelLabel || "Cancel" }),
          /* @__PURE__ */ u4(
            "button",
            {
              ref: okRef,
              type: "button",
              class: req.danger ? "danger" : "primary",
              onClick: () => close(true),
              children: req.okLabel || "OK"
            }
          )
        ] })
      ]
    }
  ) });
}

// src/components/Pane.tsx
function Pane({ paneKey, name, label, extraClass, headActions, children }) {
  const mobile = isMobile.value;
  const collapsed = !mobile && !paneOpen[paneKey].value;
  const drawer = drawerOpen[paneKey].value;
  const cls = "nc-pane " + name + (collapsed ? " collapsed" : "") + (drawer ? " open" : "") + (extraClass ? " " + extraClass : "");
  const toggle = () => {
    paneOpen[paneKey].value = !paneOpen[paneKey].value;
  };
  const onPaneClick = (ev) => {
    if (!collapsed) return;
    if (ev.target.closest("button, a")) return;
    paneOpen[paneKey].value = true;
  };
  const onHeadClick = (ev) => {
    if (mobile) return;
    if (ev.target.closest("button, a")) return;
    ev.stopPropagation();
    toggle();
  };
  return /* @__PURE__ */ u4("aside", { class: cls, id: name, onClick: onPaneClick, children: [
    /* @__PURE__ */ u4("div", { class: "head", onClick: onHeadClick, children: [
      /* @__PURE__ */ u4(
        "button",
        {
          type: "button",
          class: "icon-btn desktop-only",
          id: "btn-" + paneKey + "-toggle",
          "aria-label": collapsed ? "Expand " + label : "Collapse " + label,
          onClick: (e4) => {
            e4.stopPropagation();
            toggle();
          }
        }
      ),
      /* @__PURE__ */ u4("span", { class: "title", children: label })
    ] }),
    headActions || null,
    children
  ] });
}

// src/components/RelativeTime.tsx
function RelativeTime({ ts, className }) {
  nowTick.value;
  if (!ts) return null;
  return /* @__PURE__ */ u4("span", { class: className || "ts", title: fmtAbsolute(ts), children: fmtRelative(ts) });
}

// src/components/ThreadsRail.tsx
function threadCtxOf2(t4) {
  if (!t4 || !t4.channelType || t4.channelType === "web") return null;
  return { channelType: t4.channelType, messagingGroupId: t4.messagingGroupId ?? null, canSend: !!t4.canSend };
}
function ThreadRow({ t: t4 }) {
  const ct = t4.channelType || "web";
  const meta = channelMeta(ct);
  const active = t4.threadId === threadId.value;
  const pillTitle = `${meta.label}${t4.counterparty ? " \xB7 " + t4.counterparty : ""}`;
  const subTrailer = t4.messageCount ? " \xB7 " + t4.messageCount + " msg" : "";
  const costStr = t4.totalCost != null && t4.totalCost > 0 ? " \xB7 " + (t4.totalCost >= 1 ? "$" + t4.totalCost.toFixed(2) : "$" + t4.totalCost.toFixed(3)) : "";
  const onOpen = (ev) => {
    if (ev.target.classList.contains("del")) return;
    if (groupId.value) openChat(groupId.value, t4.threadId, threadCtxOf2(t4)).catch(console.error);
    drawerOpen.threads.value = false;
  };
  const onDel = async (ev) => {
    ev.stopPropagation();
    const ok = await requestConfirm({
      title: "Delete thread",
      message: `Delete this thread?

"${t4.title}"`,
      okLabel: "Delete",
      danger: true
    });
    if (!ok) return;
    await deleteThread(t4.threadId);
  };
  return /* @__PURE__ */ u4("div", { class: "thread" + (active ? " active" : ""), "data-id": t4.threadId, onClick: onOpen, children: [
    /* @__PURE__ */ u4("div", { class: "title", children: [
      ct !== "web" ? /* @__PURE__ */ u4("span", { class: "ch-pill", title: pillTitle, children: meta.icon }) : null,
      t4.title
    ] }),
    /* @__PURE__ */ u4("div", { class: "meta", children: [
      /* @__PURE__ */ u4(RelativeTime, { ts: t4.lastActivityAt }),
      subTrailer,
      costStr
    ] }),
    ct === "web" ? /* @__PURE__ */ u4("button", { type: "button", class: "del", title: "Delete thread", "aria-label": "Delete thread", onClick: onDel, children: "\xD7" }) : null
  ] });
}
function DmRow({ t: t4 }) {
  const ct = t4.channelType || "web";
  const meta = channelMeta(ct);
  const active = t4.threadId === threadId.value;
  const onOpen = () => {
    if (groupId.value) openChat(groupId.value, t4.threadId, threadCtxOf2(t4)).catch(console.error);
    drawerOpen.threads.value = false;
  };
  return /* @__PURE__ */ u4("div", { class: "thread dm" + (active ? " active" : ""), "data-id": t4.threadId, onClick: onOpen, children: [
    /* @__PURE__ */ u4("div", { class: "title", children: [
      /* @__PURE__ */ u4("span", { class: "ch-pill dm", title: meta.label, children: meta.icon }),
      meta.label
    ] }),
    /* @__PURE__ */ u4("div", { class: "meta", children: [
      /* @__PURE__ */ u4(RelativeTime, { ts: t4.lastActivityAt }),
      t4.counterparty ? " \xB7 " + t4.counterparty : "",
      t4.messageCount ? " \xB7 " + t4.messageCount + " msg" : ""
    ] })
  ] });
}
function renderRow(t4) {
  return t4.kind === "dm" ? /* @__PURE__ */ u4(DmRow, { t: t4 }, t4.threadId) : /* @__PURE__ */ u4(ThreadRow, { t: t4 }, t4.threadId);
}
function ChannelSection({ ct, items, defaultOpen }) {
  const [open, setOpen] = h2(defaultOpen);
  const meta = channelMeta(ct);
  const totalMsgs = items.reduce((sum, t4) => sum + (t4.messageCount || 0), 0);
  const lastActivityAt = items.reduce((latest, t4) => {
    const ts = t4.lastActivityAt || "";
    return ts > latest ? ts : latest;
  }, "");
  const handles = Array.from(new Set(items.map((t4) => t4.counterparty).filter((h5) => !!h5)));
  const handleStr = handles.length === 0 ? "" : handles.length === 1 ? handles[0] : `${handles[0]} +${handles.length - 1}`;
  return /* @__PURE__ */ u4("div", { class: "thread-section" + (open ? " open" : " collapsed"), children: [
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "thread-section-header",
        onClick: () => setOpen((o4) => !o4),
        "aria-expanded": open,
        children: [
          /* @__PURE__ */ u4("span", { class: "row", children: [
            /* @__PURE__ */ u4("span", { class: "chev", "aria-hidden": "true", children: open ? "\u25BE" : "\u25B8" }),
            /* @__PURE__ */ u4("span", { class: "ch-pill", "aria-hidden": "true", children: meta.icon }),
            /* @__PURE__ */ u4("span", { class: "label", children: meta.label }),
            /* @__PURE__ */ u4("span", { class: "count", children: [
              lastActivityAt ? /* @__PURE__ */ u4(k, { children: [
                /* @__PURE__ */ u4(RelativeTime, { ts: lastActivityAt }),
                " \xB7 "
              ] }) : null,
              items.length,
              " threads ",
              "\xB7",
              " ",
              totalMsgs,
              " msg"
            ] })
          ] }),
          handleStr ? /* @__PURE__ */ u4("span", { class: "handle", title: handles.join(", "), children: handleStr }) : null
        ]
      }
    ),
    open ? /* @__PURE__ */ u4("div", { class: "thread-section-body", children: items.map(renderRow) }) : null
  ] });
}
function SearchResultRow({ r: r4 }) {
  const meta = channelMeta(r4.channelType || "web");
  const onOpen = () => {
    if (!groupId.value) return;
    const msgId = r4.messageId;
    const tid = r4.threadId || (r4.messagingGroupId ? `__dm:${r4.messagingGroupId}` : null);
    if (!tid) return;
    drawerOpen.threads.value = false;
    const opts = r4.channelType && r4.channelType !== "web" ? { channelType: r4.channelType, messagingGroupId: r4.messagingGroupId, canSend: false } : null;
    if (threadId.value === tid) {
      setTimeout(() => {
        const el = document.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("highlight-pulse");
          setTimeout(() => el.classList.remove("highlight-pulse"), 2e3);
        }
      }, 100);
    } else {
      highlightMessageId.value = msgId;
      openChat(groupId.value, tid, opts).catch(console.error);
    }
  };
  const raw = r4.snippet || "";
  const markerPos = raw.indexOf(">>>");
  const MAX_CHARS = 120;
  let cropped = raw;
  if (markerPos > MAX_CHARS / 2) {
    cropped = "\u2026" + raw.slice(markerPos - Math.floor(MAX_CHARS / 3));
  }
  if (cropped.length > MAX_CHARS + 20) {
    cropped = cropped.slice(0, MAX_CHARS + 20) + "\u2026";
  }
  const snippetHtml = cropped.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/&gt;&gt;&gt;/g, "<mark>").replace(/&lt;&lt;&lt;/g, "</mark>");
  return /* @__PURE__ */ u4("div", { class: "thread search-result", onClick: onOpen, children: [
    /* @__PURE__ */ u4("div", { class: "title", children: [
      r4.channelType && r4.channelType !== "web" ? /* @__PURE__ */ u4("span", { class: "ch-pill", title: meta.label, children: meta.icon }) : null,
      /* @__PURE__ */ u4("span", { class: "dir-pill " + r4.direction, children: r4.direction === "in" ? "\u2190" : "\u2192" }),
      /* @__PURE__ */ u4("span", { class: "snippet", dangerouslySetInnerHTML: { __html: snippetHtml } })
    ] }),
    /* @__PURE__ */ u4("div", { class: "meta", children: /* @__PURE__ */ u4(RelativeTime, { ts: r4.timestamp }) })
  ] });
}
function SearchResults() {
  const results = searchResults.value;
  const loading = searchLoading.value;
  if (loading) return /* @__PURE__ */ u4("div", { class: "search-results", children: /* @__PURE__ */ u4("div", { class: "empty", children: "Searching\u2026" }) });
  if (!results) return null;
  if (results.length === 0) return /* @__PURE__ */ u4("div", { class: "search-results", children: /* @__PURE__ */ u4("div", { class: "empty", children: "No results" }) });
  return /* @__PURE__ */ u4("div", { class: "search-results", children: results.map((r4) => /* @__PURE__ */ u4(SearchResultRow, { r: r4 }, r4.messageId)) });
}
function ThreadsRail() {
  const list = threads.value;
  const searchInputRef = A2(null);
  const isSearching = searchResults.value !== null || searchLoading.value;
  const searchVisible = searchOpen.value || isSearching;
  y2(() => {
    if (searchVisible && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchVisible]);
  const onNewChat = () => {
    if (!groupId.value) return;
    openChat(groupId.value, null, null).then(() => {
      drawerOpen.threads.value = false;
      drawerOpen.files.value = false;
    }).catch(console.error);
  };
  const buckets = /* @__PURE__ */ new Map();
  for (const t4 of list) {
    const ct = t4.channelType || "web";
    if (!buckets.has(ct)) buckets.set(ct, []);
    buckets.get(ct).push(t4);
  }
  const sections = Array.from(buckets.entries()).map(([ct, items]) => ({ ct, label: channelMeta(ct).label, items })).sort((a4, b5) => {
    if (a4.ct === "web" && b5.ct !== "web") return -1;
    if (b5.ct === "web" && a4.ct !== "web") return 1;
    return a4.label.localeCompare(b5.label);
  });
  for (const s5 of sections) {
    s5.items.sort((a4, b5) => tsKey(b5.lastActivityAt) - tsKey(a4.lastActivityAt));
  }
  const onSearchKeyDown = (ev) => {
    if (ev.key === "Enter") {
      const q5 = ev.currentTarget.value.trim();
      if (q5 && groupId.value) searchThreads(groupId.value, q5).catch(console.error);
    }
    if (ev.key === "Escape") {
      clearSearch();
      ev.currentTarget.value = "";
    }
  };
  const onSearchClear = () => {
    clearSearch();
    if (searchInputRef.current) searchInputRef.current.value = "";
  };
  const onSearchToggle = (ev) => {
    ev.stopPropagation();
    if (searchVisible) {
      onSearchClear();
    } else {
      searchOpen.value = true;
    }
  };
  const headActions = /* @__PURE__ */ u4("div", { class: "head-actions", children: /* @__PURE__ */ u4(
    "button",
    {
      type: "button",
      class: "icon-btn search-toggle-btn",
      title: "Search threads",
      "aria-label": "Search threads",
      onClick: onSearchToggle,
      children: "\u{1F50D}"
    }
  ) });
  return /* @__PURE__ */ u4(Pane, { paneKey: "threads", name: "threads-rail", label: "Threads", headActions, children: [
    /* @__PURE__ */ u4("div", { class: "threads-actions", children: searchVisible ? /* @__PURE__ */ u4(k, { children: [
      /* @__PURE__ */ u4("span", { class: "search-icon", "aria-hidden": "true", children: "\u{1F50D}" }),
      /* @__PURE__ */ u4(
        "input",
        {
          ref: searchInputRef,
          type: "text",
          class: "search-input",
          placeholder: "Search threads\u2026",
          onKeyDown: onSearchKeyDown,
          "aria-label": "Search threads"
        }
      ),
      isSearching ? /* @__PURE__ */ u4("button", { type: "button", class: "search-clear", onClick: onSearchClear, title: "Clear search", children: "\xD7" }) : null
    ] }) : /* @__PURE__ */ u4("button", { type: "button", id: "btn-new-chat", onClick: onNewChat, children: [
      /* @__PURE__ */ u4("span", { class: "plus", children: "+" }),
      " ",
      /* @__PURE__ */ u4("span", { class: "label", children: "New thread" })
    ] }) }),
    isSearching ? /* @__PURE__ */ u4(SearchResults, {}) : /* @__PURE__ */ u4("div", { class: "list", id: "threads-list", children: list.length === 0 ? /* @__PURE__ */ u4("div", { class: "empty", children: "No threads yet" }) : sections.map((s5) => /* @__PURE__ */ u4(ChannelSection, { ct: s5.ct, items: s5.items, defaultOpen: s5.ct === "web" }, s5.ct)) })
  ] });
}

// src/recorder.ts
var isRecording = y3(false);
var recordingDuration = y3(0);
function hasGetUserMedia() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
function hasSpeechRecognition() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}
function appendTranscriptDelta(text, delta) {
  if (!text || !delta) return text + delta;
  if (/\s$/.test(text) || /^\s/.test(delta)) return text + delta;
  const endsWord = /[\p{L}\p{N}.,!?;:)\]}"]$/u.test(text);
  const startsWord = /^[\p{L}\p{N}([{"]/u.test(delta);
  if (endsWord && startsWord) return `${text} ${delta}`;
  return text + delta;
}
var mediaRecorder = null;
var audioChunks = [];
var stream = null;
var recognition = null;
var transcript = "";
var durationTimer = null;
var startTime = 0;
var recordingToken = 0;
var MIN_DURATION_MS = 2e3;
async function startRecording(transcribe) {
  if (isRecording.value) return true;
  if (!hasGetUserMedia()) return false;
  const token = ++recordingToken;
  let nextStream;
  try {
    nextStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return false;
  }
  if (token !== recordingToken) {
    for (const track of nextStream.getTracks()) track.stop();
    return false;
  }
  stream = nextStream;
  audioChunks = [];
  transcript = "";
  const mimeType = MediaRecorder.isTypeSupported("audio/ogg;codecs=opus") ? "audio/ogg;codecs=opus" : MediaRecorder.isTypeSupported("audio/mp4;codecs=opus") ? "audio/mp4;codecs=opus" : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : void 0);
  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) audioChunks.push(ev.data);
  };
  mediaRecorder.start(250);
  startTime = Date.now();
  recordingDuration.value = 0;
  durationTimer = setInterval(() => {
    recordingDuration.value = Date.now() - startTime;
  }, 200);
  if (transcribe && hasSpeechRecognition()) {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (ev) => {
      for (let i5 = ev.resultIndex; i5 < ev.results.length; i5++) {
        if (ev.results[i5].isFinal) {
          transcript += ev.results[i5][0].transcript;
        }
      }
    };
    recognition.onerror = () => {
    };
    try {
      recognition.start();
    } catch {
    }
  }
  isRecording.value = true;
  return true;
}
function stopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      cleanup();
      resolve(null);
      return;
    }
    mediaRecorder.onstop = () => {
      const durationMs = Date.now() - startTime;
      const mimeType = mediaRecorder?.mimeType || "audio/webm";
      const chunks = audioChunks.slice();
      const finalTranscript = transcript.trim() || null;
      cleanup();
      if (durationMs < MIN_DURATION_MS) {
        resolve(null);
        return;
      }
      const ext = mimeType.includes("webm") ? "webm" : "ogg";
      const blob = new Blob(chunks, { type: mimeType });
      resolve({
        blob,
        transcript: finalTranscript,
        durationMs
      });
    };
    if (recognition) {
      try {
        recognition.stop();
      } catch {
      }
    }
    mediaRecorder.stop();
  });
}
function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  if (recognition) {
    try {
      recognition.stop();
    } catch {
    }
  }
  cleanup();
}
function cleanup() {
  recordingToken++;
  if (durationTimer) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  mediaRecorder = null;
  recognition = null;
  audioChunks = [];
  isRecording.value = false;
  recordingDuration.value = 0;
}
function transcribeViaServer(blob, groupId2, threadId2, callbacks) {
  const controller = new AbortController();
  const fd = new FormData();
  const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("mp4") ? "mp4" : "ogg";
  fd.append("audio", blob, `voice.${ext}`);
  const url = `/ui/chat/api/groups/${encodeURIComponent(groupId2)}/chat/${encodeURIComponent(threadId2)}/voice/transcribe`;
  fetch(url, {
    method: "POST",
    body: fd,
    signal: controller.signal,
    credentials: "same-origin"
  }).then(async (res) => {
    if (!res.ok || !res.body) {
      const errJson = await res.text().catch(() => "");
      callbacks.onError(errJson || `http_${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let fullText = "";
    let doneFired = false;
    const fireDone = (text) => {
      if (doneFired) return;
      doneFired = true;
      callbacks.onDone(text);
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            if (eventType === "partial" && parsed.text) {
              const nextText = appendTranscriptDelta(fullText, parsed.text);
              const normalizedDelta = nextText.slice(fullText.length);
              fullText = nextText;
              callbacks.onPartial(normalizedDelta);
            } else if (eventType === "done" && parsed.text) {
              fireDone(parsed.text);
            } else if (eventType === "error") {
              callbacks.onError(parsed.error || "transcription_failed");
            }
          } catch {
          }
          eventType = "";
        }
      }
    }
    if (fullText && !controller.signal.aborted) {
      fireDone(fullText);
    }
  }).catch((err) => {
    if (!controller.signal.aborted) {
      callbacks.onError(err instanceof Error ? err.message : "network_error");
    }
  });
  return controller;
}

// src/components/ComposerPlusMenu.tsx
function ComposerPlusMenu({
  disabled,
  title,
  showRecordAudio,
  showQuickCapture,
  onUploadFile,
  onQuickCapture,
  onRecordAudio
}) {
  const [open, setOpen] = h2(false);
  const wrapRef = A2(null);
  y2(() => {
    if (!open) return void 0;
    const onDoc = (ev) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target)) setOpen(false);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (fn2) => (ev) => {
    ev.stopPropagation();
    setOpen(false);
    fn2();
  };
  return /* @__PURE__ */ u4("div", { class: "composer-plus" + (open ? " open" : ""), ref: wrapRef, children: [
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        id: "chat-attach",
        class: "composer-plus-trigger",
        title: title || "Add\u2026",
        "aria-label": "Add",
        "aria-haspopup": "menu",
        "aria-expanded": open,
        disabled,
        onClick: (ev) => {
          ev.stopPropagation();
          setOpen((o4) => !o4);
        },
        children: "+"
      }
    ),
    open ? /* @__PURE__ */ u4("div", { class: "composer-plus-panel", role: "menu", children: [
      showQuickCapture ? /* @__PURE__ */ u4("button", { type: "button", class: "composer-plus-item", role: "menuitem", onClick: pick(onQuickCapture), children: [
        /* @__PURE__ */ u4("span", { class: "ico", children: "\u{1F4F7}" }),
        /* @__PURE__ */ u4("span", { class: "lbl", children: "Take photo" })
      ] }) : null,
      /* @__PURE__ */ u4("button", { type: "button", class: "composer-plus-item", role: "menuitem", onClick: pick(onUploadFile), children: [
        /* @__PURE__ */ u4("span", { class: "ico", children: "\u{1F4CE}" }),
        /* @__PURE__ */ u4("span", { class: "lbl", children: "Upload file" })
      ] }),
      showRecordAudio ? /* @__PURE__ */ u4("button", { type: "button", class: "composer-plus-item", role: "menuitem", onClick: pick(onRecordAudio), children: [
        /* @__PURE__ */ u4("span", { class: "ico", children: "\u{1F399}\uFE0F" }),
        /* @__PURE__ */ u4("span", { class: "lbl", children: "Record audio attachment" })
      ] }) : null
    ] }) : null
  ] });
}

// src/components/QuickCapture.tsx
var CAPTURE_WIDTH = 1280;
var CAPTURE_HEIGHT = 960;
var JPEG_QUALITY = 0.85;
function QuickCapture({ onCapture, onClose }) {
  const videoRef = A2(null);
  const streamRef = A2(null);
  const [error, setError] = h2(null);
  const [preview, setPreview] = h2(null);
  const [busy, setBusy] = h2(false);
  const [facing, setFacing] = h2("environment");
  y2(() => {
    let cancelled = false;
    const start = async () => {
      try {
        const stream2 = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facing },
            width: { ideal: CAPTURE_WIDTH },
            height: { ideal: CAPTURE_HEIGHT }
          }
        });
        if (cancelled) {
          stream2.getTracks().forEach((t4) => t4.stop());
          return;
        }
        streamRef.current = stream2;
        const v5 = videoRef.current;
        if (v5) {
          v5.srcObject = stream2;
          v5.play().catch(() => void 0);
        }
      } catch (err) {
        const name = err.name;
        if (name === "NotAllowedError" || name === "SecurityError") {
          setError("Camera permission denied");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setError("No camera available");
        } else {
          setError("Could not start camera");
        }
      }
    };
    start();
    return () => {
      cancelled = true;
      const s5 = streamRef.current;
      if (s5) {
        s5.getTracks().forEach((t4) => t4.stop());
        streamRef.current = null;
      }
    };
  }, [facing]);
  y2(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);
  y2(() => {
    const onKey = (ev) => {
      if (ev.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const shoot = async () => {
    const v5 = videoRef.current;
    if (!v5 || busy) return;
    const w5 = v5.videoWidth;
    const h5 = v5.videoHeight;
    if (!w5 || !h5) return;
    setBusy(true);
    try {
      const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w5, h5) : Object.assign(document.createElement("canvas"), { width: w5, height: h5 });
      const ctx2 = canvas.getContext("2d");
      if (!ctx2) throw new Error("no 2d context");
      ctx2.drawImage(v5, 0, 0, w5, h5);
      let blob = null;
      if (canvas instanceof OffscreenCanvas) {
        blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
      } else {
        blob = await new Promise(
          (resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
        );
      }
      if (!blob) throw new Error("encode failed");
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ url: URL.createObjectURL(blob), blob });
    } catch (err) {
      setError(err.message || "Capture failed");
    } finally {
      setBusy(false);
    }
  };
  const retake = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };
  const use = () => {
    if (!preview) return;
    const file = new File([preview.blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
    setPreview(null);
    URL.revokeObjectURL(preview.url);
    onCapture(file);
  };
  const flip = () => setFacing((f5) => f5 === "environment" ? "user" : "environment");
  const flipTarget = facing === "environment" ? "Front camera" : "Back camera";
  const onBackdrop = (ev) => {
    if (ev.target.classList.contains("qcap-backdrop")) onClose();
  };
  return /* @__PURE__ */ u4("div", { class: "qcap-backdrop", onClick: onBackdrop, children: /* @__PURE__ */ u4("div", { class: "qcap-modal", role: "dialog", "aria-label": "Quick capture", children: [
    /* @__PURE__ */ u4("button", { type: "button", class: "qcap-close", onClick: onClose, "aria-label": "Close", children: "\xD7" }),
    /* @__PURE__ */ u4("div", { class: "qcap-stage", children: error ? /* @__PURE__ */ u4("div", { class: "qcap-error", children: error }) : preview ? /* @__PURE__ */ u4("img", { class: "qcap-preview", src: preview.url, alt: "" }) : /* @__PURE__ */ u4(
      "video",
      {
        class: "qcap-video" + (facing === "user" ? " mirror" : ""),
        ref: videoRef,
        playsInline: true,
        muted: true,
        autoplay: true
      }
    ) }),
    /* @__PURE__ */ u4("div", { class: "qcap-controls", children: error ? /* @__PURE__ */ u4("button", { type: "button", class: "qcap-btn", onClick: onClose, children: "Close" }) : preview ? /* @__PURE__ */ u4(k, { children: [
      /* @__PURE__ */ u4("button", { type: "button", class: "qcap-btn", onClick: retake, children: "Retake" }),
      /* @__PURE__ */ u4("button", { type: "button", class: "qcap-btn primary", onClick: use, children: "Use photo" })
    ] }) : /* @__PURE__ */ u4(k, { children: [
      /* @__PURE__ */ u4(
        "button",
        {
          type: "button",
          class: "qcap-flip",
          onClick: flip,
          "aria-label": `Switch to ${flipTarget.toLowerCase()}`,
          title: `Switch to ${flipTarget.toLowerCase()}`,
          children: [
            /* @__PURE__ */ u4("span", { class: "qcap-flip-ico", "aria-hidden": "true", children: "\u21BB" }),
            /* @__PURE__ */ u4("span", { class: "qcap-flip-lbl", children: flipTarget })
          ]
        }
      ),
      /* @__PURE__ */ u4("button", { type: "button", class: "qcap-shutter", onClick: shoot, disabled: busy, "aria-label": "Capture" }),
      /* @__PURE__ */ u4("span", { class: "qcap-spacer" })
    ] }) })
  ] }) });
}

// src/components/ChatMain.tsx
function fmtTok(n3) {
  if (n3 >= 1e6) return (n3 / 1e6).toFixed(1) + "M";
  if (n3 >= 1e3) return (n3 / 1e3).toFixed(1) + "k";
  return String(n3);
}
function fmtActivityTs(ts) {
  if (!ts) return "";
  const n3 = Number(ts);
  if (!Number.isFinite(n3)) return "";
  return new Date(n3).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function splitTraceText(text) {
  const i5 = text.indexOf("`");
  if (i5 < 0) return { prefix: text, code: null };
  const prefix = text.slice(0, i5).trim();
  const rest = text.slice(i5 + 1);
  const j6 = rest.lastIndexOf("`");
  const code = j6 >= 0 ? rest.slice(0, j6) : rest;
  return { prefix, code };
}
function parseStep(text) {
  const t4 = text.trim();
  if (t4.startsWith("{")) {
    try {
      const o4 = JSON.parse(t4);
      if (o4 && typeof o4 === "object" && typeof o4.kind === "string") return o4;
    } catch {
    }
  }
  return { legacy: text };
}
function cleanToolName(tool) {
  if (tool.startsWith("mcp__")) {
    const rest = tool.slice(5);
    const [server, ...name] = rest.split("__");
    return `${server}.${name.join(".") || rest}`;
  }
  return tool.toLowerCase();
}
function stepPhrase(s5) {
  switch (s5.kind) {
    case "thinking":
      return "Thinking\u2026";
    case "text":
      return "Writing reply\u2026";
    case "permission":
      return "Requesting permission\u2026";
    case "notification":
      return s5.text || "Notification";
    default:
      return "";
  }
}
function stepSummary(s5) {
  if (s5.legacy != null) return s5.legacy;
  if (s5.kind === "tool") {
    const label = cleanToolName(s5.tool || "tool");
    const d5 = s5.detail ? " " + s5.detail.replace(/\s+/g, " ").trim() : "";
    return `Using ${label}${d5}`;
  }
  return stepPhrase(s5);
}
function ActivityTraceRow({ line, open, onToggle }) {
  const step = parseStep(line.text);
  const legacy = step.legacy != null ? splitTraceText(step.legacy) : null;
  const isTool = step.kind === "tool";
  const code = !open ? null : legacy ? legacy.code : isTool ? step.detail ?? null : null;
  const prefix = legacy ? legacy.prefix ? /* @__PURE__ */ u4("span", { class: "trace-prefix", children: legacy.prefix }) : null : isTool ? /* @__PURE__ */ u4("span", { class: "trace-prefix", children: [
    "Using ",
    /* @__PURE__ */ u4("code", { class: "trace-tool", children: cleanToolName(step.tool || "") }),
    " tool"
  ] }) : /* @__PURE__ */ u4("span", { class: "trace-prefix", children: stepPhrase(step) });
  return /* @__PURE__ */ u4("li", { class: `trace-row${open ? " open" : ""}`, children: [
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "trace-row-toggle",
        "aria-expanded": open,
        title: open ? "Collapse step" : stepSummary(step),
        onClick: onToggle,
        children: [
          /* @__PURE__ */ u4("span", { class: `chevron${open ? " open" : ""}`, children: "\u203A" }),
          line.ts ? /* @__PURE__ */ u4("span", { class: "ts", children: fmtActivityTs(line.ts) }) : null,
          open ? prefix : /* @__PURE__ */ u4("span", { class: "trace-text", children: stepSummary(step) })
        ]
      }
    ),
    open && code != null ? /* @__PURE__ */ u4("pre", { class: "trace-code", children: /* @__PURE__ */ u4("code", { children: code }) }) : null
  ] });
}
function ActivityTraceList({ lines }) {
  const [sel, setSel] = h2(null);
  const toggle = (i5) => setSel((cur) => cur === i5 ? null : i5);
  return /* @__PURE__ */ u4("ul", { class: "activity-trace", children: lines.map((line, i5) => /* @__PURE__ */ u4(ActivityTraceRow, { line, open: i5 === sel, onToggle: () => toggle(i5) }, i5)) });
}
function ActivityTrace({ lines }) {
  const [expanded, setExpanded] = h2(false);
  if (!lines.length) return null;
  return /* @__PURE__ */ u4("div", { class: `msg-activity${expanded ? " expanded" : ""}`, children: [
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "trace-toggle",
        "aria-expanded": expanded,
        "aria-label": expanded ? "Hide activity" : "Show activity",
        title: expanded ? "Hide activity" : "Show activity",
        onClick: () => setExpanded((v5) => !v5),
        children: [
          /* @__PURE__ */ u4("span", { class: `chevron${expanded ? " open" : ""}`, children: "\u203A" }),
          /* @__PURE__ */ u4("span", { class: "trace-count", children: [
            lines.length,
            " step",
            lines.length === 1 ? "" : "s"
          ] })
        ]
      }
    ),
    expanded ? /* @__PURE__ */ u4(ActivityTraceList, { lines }) : null
  ] });
}
function fmtCost(usd) {
  if (usd >= 1) return "$" + usd.toFixed(2);
  if (usd >= 0.01) return "$" + usd.toFixed(3);
  return "$" + usd.toFixed(4);
}
function fmtDur(ms) {
  if (ms >= 6e4) return Math.round(ms / 6e4) + "m";
  return Math.round(ms / 1e3) + "s";
}
function shortModel(model) {
  return model.split("/").pop() || model;
}
function mediaKind(filename, contentType) {
  if (contentType?.startsWith("audio/")) return "audio";
  if (contentType?.startsWith("video/")) return "video";
  const ext = filename.toLowerCase().split(".").pop() || "";
  if (["webm", "m4a", "mp3", "ogg", "wav", "aac", "flac"].includes(ext)) return "audio";
  if (["mp4", "mov", "m4v", "ogv"].includes(ext)) return "video";
  return null;
}
function UsageMeta({ u: u5 }) {
  const [expanded, setExpanded] = h2(false);
  const cost = fmtCost(u5.cost_usd);
  const model = u5.model ? shortModel(u5.model) : "";
  const dur = u5.duration_ms ? fmtDur(u5.duration_ms) : "";
  const short = [cost, dur, model].filter(Boolean).join(" \xB7 ");
  const tokens = `${fmtTok(u5.input_tokens)}\u2192${fmtTok(u5.output_tokens)}`;
  const cache = [
    u5.cache_read_tokens > 0 ? `cache read ${fmtTok(u5.cache_read_tokens)}` : "",
    u5.cache_write_tokens > 0 ? `cache write ${fmtTok(u5.cache_write_tokens)}` : "",
    u5.reasoning_tokens ? `reasoning ${fmtTok(u5.reasoning_tokens)}` : ""
  ].filter(Boolean).join(" \xB7 ");
  const detail = [tokens, cache].filter(Boolean).join(" \xB7 ");
  return /* @__PURE__ */ u4("span", { class: "usage", onClick: (e4) => {
    e4.stopPropagation();
    setExpanded((v5) => !v5);
  }, title: "Click for details", children: [
    short,
    expanded && detail ? ` \xB7 ${detail}` : ""
  ] });
}
function Message({ m: m6 }) {
  const ref = A2(null);
  const mdRef = A2(null);
  const md = renderMarkdown(m6.text);
  const q5 = searchQuery.value;
  y2(() => {
    if (md != null && mdRef.current) mdRef.current.innerHTML = md;
    if (md != null && mdRef.current && groupId.value) {
      rewriteFileLinks(mdRef.current, groupId.value, (entry) => navFile(entry).catch(console.error));
      for (const a4 of mdRef.current.querySelectorAll("a.msg-ref")) {
        a4.addEventListener("click", (ev) => {
          ev.preventDefault();
          const tid = a4.dataset.threadId;
          const msgId = a4.dataset.msgId;
          if (tid && groupId.value) {
            highlightMessageId.value = msgId || null;
            if (threadId.value === tid) {
              setTimeout(() => {
                highlightMessageId.value = msgId || null;
              }, 50);
            } else {
              openChat(groupId.value, tid, null).catch(console.error);
            }
          }
        });
      }
    }
    if (q5 && ref.current) highlightTextNodes(ref.current, q5);
  }, [m6.text, md != null, q5]);
  const cls = "msg " + m6.direction + (md != null ? " markdown" : "");
  const singleFile = m6.files?.length === 1 ? m6.files[0] : null;
  const singleMediaKind = singleFile?.url && !m6.text.trim() ? mediaKind(singleFile.filename, singleFile.contentType) : null;
  return /* @__PURE__ */ u4("div", { class: cls, "data-msg-id": m6.id, ref, children: [
    m6.direction === "internal" ? /* @__PURE__ */ u4("div", { class: "internal-label", children: "internal" }) : null,
    md != null ? /* @__PURE__ */ u4("div", { ref: mdRef, dangerouslySetInnerHTML: { __html: md } }) : m6.text || "",
    singleFile && singleMediaKind ? /* @__PURE__ */ u4("div", { class: "inline-media", children: [
      singleMediaKind === "audio" ? /* @__PURE__ */ u4("audio", { controls: true, preload: "metadata", src: singleFile.url, title: singleFile.filename }) : /* @__PURE__ */ u4("video", { controls: true, preload: "metadata", src: singleFile.url, title: singleFile.filename }),
      /* @__PURE__ */ u4("div", { class: "inline-media-name", children: singleFile.filename })
    ] }) : null,
    m6.files && m6.files.length && !singleMediaKind ? /* @__PURE__ */ u4("div", { class: "files", children: m6.files.map((f5) => f5.path ? /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "file-chip",
        title: "/" + f5.path,
        onClick: () => navFile({ path: f5.path, name: f5.filename, size: f5.size }).catch(console.error),
        children: [
          "\u{1F4CE} ",
          f5.filename
        ]
      },
      f5.path
    ) : /* @__PURE__ */ u4("span", { class: "file-chip inert", title: "Source not in workspace", children: [
      "\u{1F4CE} ",
      f5.filename
    ] }, f5.filename)) }) : null,
    m6.direction === "out" && m6.activity && m6.activity.length ? /* @__PURE__ */ u4(ActivityTrace, { lines: m6.activity }) : null,
    m6.ts ? /* @__PURE__ */ u4("div", { class: "meta", children: [
      /* @__PURE__ */ u4(RelativeTime, { ts: m6.ts }),
      m6.usage && m6.direction === "out" ? /* @__PURE__ */ u4(UsageMeta, { u: m6.usage }) : null
    ] }) : null
  ] });
}
function groupMessages(list) {
  const out = [];
  let pendingMsgs = [];
  for (const m6 of list) {
    if (m6.direction === "internal") {
      pendingMsgs.push(m6);
    } else if (m6.direction === "out" && pendingMsgs.length > 0) {
      out.push({ kind: "thoughts", thoughts: pendingMsgs, answer: m6 });
      pendingMsgs = [];
    } else {
      out.push({ kind: "single", m: m6 });
    }
  }
  for (const t4 of pendingMsgs) out.push({ kind: "single", m: t4 });
  return out;
}
function ThoughtGroup({ thoughts, answer }) {
  const [showThoughts, setShowThoughts] = h2(false);
  const n3 = thoughts.length;
  const label = showThoughts ? "answer" : n3 > 1 ? `thoughts (${n3})` : "thoughts";
  const title = showThoughts ? "Show final answer" : "Show agent thoughts leading to this answer";
  return /* @__PURE__ */ u4("div", { class: "thought-group" + (showThoughts ? " showing-thoughts" : " showing-answer"), children: [
    showThoughts ? thoughts.map((t4, i5) => /* @__PURE__ */ u4(Message, { m: t4 }, "t" + i5)) : /* @__PURE__ */ u4(Message, { m: answer }),
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "thoughts-toggle",
        title,
        onClick: () => setShowThoughts((v5) => !v5),
        children: label
      }
    )
  ] });
}
function ApprovalsBanner() {
  const list = pendingApprovals.value;
  if (list.length === 0) return null;
  const busy = respondingApprovalIds.value;
  return /* @__PURE__ */ u4("div", { class: "approvals-banner", children: [
    /* @__PURE__ */ u4("div", { class: "approvals-header", children: [
      "Pending approvals ",
      /* @__PURE__ */ u4("span", { class: "approvals-count", children: [
        "(",
        list.length,
        ")"
      ] })
    ] }),
    list.map((a4) => /* @__PURE__ */ u4("div", { class: "approval-row", children: [
      /* @__PURE__ */ u4("div", { class: "approval-text", children: [
        /* @__PURE__ */ u4("div", { class: "approval-title", children: a4.title || a4.action }),
        a4.details ? /* @__PURE__ */ u4("div", { class: "approval-details", children: a4.details }) : null,
        /* @__PURE__ */ u4("div", { class: "approval-meta", children: [
          /* @__PURE__ */ u4("span", { class: "approval-group", children: a4.agentGroupName || "Global" }),
          /* @__PURE__ */ u4("span", { class: "dot", children: "\xB7" }),
          /* @__PURE__ */ u4(RelativeTime, { ts: a4.createdAt })
        ] })
      ] }),
      /* @__PURE__ */ u4("div", { class: "approval-actions", children: a4.options.length === 0 ? /* @__PURE__ */ u4("span", { class: "approval-disabled", children: "no options" }) : a4.options.map((o4) => /* @__PURE__ */ u4(
        "button",
        {
          type: "button",
          class: "approval-btn approval-" + (o4.value === "approve" ? "approve" : o4.value === "reject" ? "reject" : "neutral"),
          disabled: busy.has(a4.approvalId),
          onClick: () => respondApproval(a4.approvalId, o4.value).catch(console.error),
          children: o4.label
        },
        o4.value
      )) })
    ] }, a4.approvalId))
  ] });
}
function MessageLog() {
  const ref = A2(null);
  const appliedHighlightRef = A2(null);
  const prevMsgCountRef = A2(0);
  const wasTypingRef = A2(false);
  const prevScrollTickRef = A2(scrollToBottomTick.value);
  const prevTraceLenRef = A2(0);
  const prevExpandedRef = A2(false);
  const [traceExpanded, setTraceExpanded] = h2(false);
  const highlight = highlightMessageId.value;
  const msgCount = chatMessages.value.length;
  const typing = isTyping.value && !!threadId.value && !chatLoading.value;
  const scrollTick = scrollToBottomTick.value;
  const traceLen = activityLog.value.length;
  const scrollToBottom = () => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  };
  const atBottomRef = A2(true);
  const onLogScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  y2(() => {
    if (!ref.current) return;
    if (scrollTick !== prevScrollTickRef.current) {
      prevScrollTickRef.current = scrollTick;
      scrollToBottom();
      return;
    }
    if (highlight) {
      if (appliedHighlightRef.current && appliedHighlightRef.current !== highlight) {
        appliedHighlightRef.current = null;
      }
      const el = ref.current.querySelector(`[data-msg-id="${CSS.escape(highlight)}"]`);
      if (el && appliedHighlightRef.current !== highlight) {
        appliedHighlightRef.current = highlight;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("highlight-pulse");
        setTimeout(() => el.classList.remove("highlight-pulse"), 2e3);
      }
    } else {
      appliedHighlightRef.current = null;
      const newMessages = msgCount !== prevMsgCountRef.current;
      const typingJustStarted = typing && !wasTypingRef.current;
      const traceGrew = traceLen > prevTraceLenRef.current;
      const justExpanded = traceExpanded && !prevExpandedRef.current;
      if (traceExpanded && traceGrew) {
        const ul = ref.current.querySelector(".activity-trace");
        if (ul) ul.scrollTop = ul.scrollHeight;
      }
      if (newMessages || typingJustStarted || justExpanded || traceExpanded && traceGrew && atBottomRef.current) {
        prevMsgCountRef.current = msgCount;
        scrollToBottom();
      }
      prevTraceLenRef.current = traceLen;
    }
    wasTypingRef.current = !!typing;
    prevExpandedRef.current = traceExpanded;
  });
  const list = chatMessages.value;
  const groups2 = groupMessages(list);
  return /* @__PURE__ */ u4("div", { class: "log", id: "chat-log", ref, onScroll: onLogScroll, children: [
    chatLoading.value ? null : !threadId.value ? /* @__PURE__ */ u4("div", { class: "empty", children: "Pick or start a chat." }) : list.length === 0 ? /* @__PURE__ */ u4("div", { class: "empty", children: "No messages yet." }) : groups2.map((g8, i5) => g8.kind === "thoughts" ? /* @__PURE__ */ u4(ThoughtGroup, { thoughts: g8.thoughts, answer: g8.answer }, i5) : /* @__PURE__ */ u4(Message, { m: g8.m }, i5)),
    typing ? /* @__PURE__ */ u4("div", { class: `typing${traceExpanded ? " expanded" : ""}`, "aria-live": "polite", children: [
      /* @__PURE__ */ u4("div", { class: "typing-dots", children: [
        /* @__PURE__ */ u4("span", {}),
        /* @__PURE__ */ u4("span", {}),
        /* @__PURE__ */ u4("span", {}),
        !traceExpanded && typingHint.value ? /* @__PURE__ */ u4("span", { class: "hint", children: typingHint.value }) : null,
        activityLog.value.length ? /* @__PURE__ */ u4(
          "button",
          {
            type: "button",
            class: "trace-toggle",
            "aria-expanded": traceExpanded,
            "aria-label": traceExpanded ? "Hide activity" : "Show activity",
            title: traceExpanded ? "Hide activity" : "Show activity",
            onClick: () => setTraceExpanded((v5) => !v5),
            children: /* @__PURE__ */ u4("span", { class: `chevron${traceExpanded ? " open" : ""}`, children: "\u203A" })
          }
        ) : null
      ] }),
      traceExpanded && activityLog.value.length ? /* @__PURE__ */ u4(ActivityTraceList, { lines: activityLog.value }) : null
    ] }) : null
  ] });
}
function ContextChip() {
  const pins = pinnedContext.value;
  if (pins.length === 0) return /* @__PURE__ */ u4("div", { class: "context", id: "chat-context", hidden: true });
  return /* @__PURE__ */ u4("div", { class: "context", id: "chat-context", children: pins.map((p5) => /* @__PURE__ */ u4("span", { class: "chip", children: [
    /* @__PURE__ */ u4("span", { children: "\u{1F4CE}" }),
    /* @__PURE__ */ u4("span", { class: "path", title: p5, children: p5 }),
    /* @__PURE__ */ u4("button", { type: "button", title: "Unpin", onClick: () => removePinnedPath(p5), children: "\xD7" })
  ] }, p5)) });
}
function PendingTray() {
  const list = pending.value;
  if (list.length === 0) return /* @__PURE__ */ u4("div", { class: "pending", id: "chat-pending", hidden: true });
  return /* @__PURE__ */ u4("div", { class: "pending", id: "chat-pending", children: list.map((f5, i5) => /* @__PURE__ */ u4("span", { class: "item", children: [
    "\u{1F4CE} ",
    f5.name,
    " (",
    fmtBytesShort(f5.size),
    ")",
    /* @__PURE__ */ u4("button", { type: "button", title: "Remove", onClick: () => removePending(i5), children: "\xD7" })
  ] }, i5)) });
}
function QuestionCard() {
  const questions = pendingQuestions.value;
  const tid = threadId.value;
  const visible = questions.filter((q5) => !q5.threadId || q5.threadId === tid);
  if (visible.length === 0) return null;
  const busy = respondingQuestionIds.value;
  return /* @__PURE__ */ u4("div", { class: "question-card-tray", children: visible.map((q5) => /* @__PURE__ */ u4("div", { class: "question-card", children: [
    /* @__PURE__ */ u4("div", { class: "question-card-title", children: q5.title }),
    /* @__PURE__ */ u4("div", { class: "question-card-actions", children: q5.options.map((o4) => /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "question-card-btn",
        disabled: busy.has(q5.questionId),
        onClick: () => respondQuestion(q5.questionId, o4.value).catch(console.error),
        children: o4.label
      },
      o4.value
    )) })
  ] }, q5.questionId)) });
}
var REFUSAL_PATTERNS = [
  /^i'?m sorry,? (but )?i (can'?t|cannot)/i,
  /^i (can'?t|cannot) (process|transcribe|help|assist|fulfill|comply)/i,
  /^sorry,? (but )?i (can'?t|cannot)/i,
  /^as an ai (language )?model/i,
  /^i (do not|don'?t) have the ability to/i
];
function looksLikeRefusal(text) {
  const head = text.slice(0, 200);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}
function Composer() {
  const inputRef = A2(null);
  const fileRef = A2(null);
  const [quickCapture, setQuickCapture] = h2(false);
  const isWeb = !channelType.value || channelType.value === "web";
  const showComposer = isWeb || canSend.value;
  const wsDown = isWeb && chatStatus.value !== "connected";
  const hasQuestion = pendingQuestions.value.some((q5) => !q5.threadId || q5.threadId === threadId.value);
  const composerDisabled = wsDown || hasQuestion;
  const autosize = () => {
    const el = inputRef.current;
    if (!el) return;
    if (!el.value) {
      el.style.height = "";
      el.style.overflowY = "hidden";
      setMultiLine(false);
      return;
    }
    el.style.height = "auto";
    const h5 = Math.min(el.scrollHeight, 200);
    el.style.height = h5 + "px";
    el.style.overflowY = h5 >= 200 ? "auto" : "hidden";
    setMultiLine(h5 > 44);
  };
  y2(() => {
    autosize();
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(autosize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onSubmit = (ev) => {
    ev.preventDefault();
    if (recording && recordingModeRef.current === "mic") {
      autoSendRef.current = true;
      finishRecording().catch(console.error);
      return;
    }
    if (transcribingRef.current) {
      autoSendRef.current = true;
      return;
    }
    doSubmit();
  };
  const doSubmit = () => {
    const text = (inputRef.current?.value || "").trim();
    const files = pending.value.slice();
    if (!text && files.length === 0) return;
    const pins = pinnedContext.value;
    const prefix = pins.length > 0 ? "> Context (file browser):\n" + pins.map((p5) => `> - \`${p5}\``).join("\n") + "\n\n" : "";
    const fullText = prefix + text;
    if (inputRef.current) inputRef.current.value = "";
    autosize();
    clearPending();
    clearPinnedContext();
    sendChat(fullText, files).catch(console.error);
  };
  const autoSendRef = A2(false);
  const maybeAutoSend = () => {
    if (!autoSendRef.current) return;
    autoSendRef.current = false;
    doSubmit();
  };
  const onKey = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !isMobile.value) {
      ev.preventDefault();
      ev.currentTarget.form?.requestSubmit();
    }
  };
  const onAttachClick = () => fileRef.current?.click();
  const addFiles = (files) => {
    if (files.length === 0) return;
    addPendingFiles(files, UPLOAD_MAX_FILES, UPLOAD_MAX_FILE_SIZE, UPLOAD_MAX_TOTAL_SIZE);
  };
  const onFileChange = (ev) => {
    const files = Array.from(ev.currentTarget.files || []);
    ev.currentTarget.value = "";
    addFiles(files);
  };
  const onPaste = (ev) => {
    const items = ev.clipboardData && ev.clipboardData.files;
    if (!items || items.length === 0) return;
    ev.preventDefault();
    addFiles(Array.from(items));
  };
  const vm = voiceMode.value;
  const serverTranscribeAvailable = vm !== "off";
  const micCapable = hasGetUserMedia() && (serverTranscribeAvailable || hasSpeechRecognition());
  const recording = isRecording.value;
  const holdTimerRef = A2(null);
  const holdModeRef = A2(false);
  const recordingModeRef = A2(null);
  const attachRecording = recording && recordingModeRef.current === "attach";
  const transcribingRef = A2(false);
  const [transcribeStatus, setTranscribeStatus] = h2("");
  const [multiLine, setMultiLine] = h2(false);
  const pendingInsertRef = A2(null);
  const doInsert = (el, text) => {
    const cur = el.value;
    const hasFocus = document.activeElement === el;
    const start = hasFocus ? el.selectionStart ?? cur.length : cur.length;
    const end = hasFocus ? el.selectionEnd ?? start : cur.length;
    const before = cur.slice(0, start);
    const after = cur.slice(end);
    const leftPad = before && !/\s$/.test(before) ? " " : "";
    const rightPad = after && !/^\s/.test(after) ? " " : "";
    const insert = leftPad + text + rightPad;
    el.value = before + insert + after;
    autosize();
    const caret = (before + insert).length;
    if (!isMobile.value) {
      el.focus();
      el.setSelectionRange(caret, caret);
    }
    maybeAutoSend();
  };
  y2(() => {
    if (pendingInsertRef.current == null) return;
    const el = inputRef.current;
    if (!el) return;
    const text = pendingInsertRef.current;
    pendingInsertRef.current = null;
    doInsert(el, text);
  });
  const insertIntoComposer = (text) => {
    const el = inputRef.current;
    if (el) {
      doInsert(el, text);
      return;
    }
    const queued = pendingInsertRef.current;
    pendingInsertRef.current = queued ? `${queued} ${text}` : text;
  };
  const attachAudioBlob = (blob) => {
    const rawType = blob.type.split(";")[0] || "audio/mp4";
    const ext = rawType.includes("ogg") ? "ogg" : rawType.includes("mp4") ? "m4a" : rawType.includes("wav") ? "wav" : "webm";
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: rawType });
    addPendingFiles([file], UPLOAD_MAX_FILES, UPLOAD_MAX_FILE_SIZE, UPLOAD_MAX_TOTAL_SIZE);
  };
  const finishRecording = async () => {
    const mode = recordingModeRef.current;
    recordingModeRef.current = null;
    const result = await stopRecording();
    if (!result) {
      chatStatus.value = "too short \u2014 discarded";
      setTimeout(() => {
        if (chatStatus.value === "too short \u2014 discarded") chatStatus.value = "connected";
      }, 2e3);
      maybeAutoSend();
      return;
    }
    if (mode === "attach") {
      attachAudioBlob(result.blob);
      return;
    }
    if (result.transcript) {
      insertIntoComposer(result.transcript);
      return;
    }
    if (!serverTranscribeAvailable) {
      chatStatus.value = "transcription unavailable";
      setTimeout(() => {
        if (chatStatus.value === "transcription unavailable") chatStatus.value = "connected";
      }, 3e3);
      maybeAutoSend();
      return;
    }
    if (!groupId.value || !threadId.value) {
      maybeAutoSend();
      return;
    }
    transcribingRef.current = true;
    setTranscribeStatus("transcribing\u2026");
    transcribeViaServer(result.blob, groupId.value, threadId.value, {
      onPartial: (delta) => {
        setTranscribeStatus((prev) => {
          const cur = prev === "transcribing\u2026" ? "" : prev;
          return cur + delta;
        });
      },
      onDone: (fullText) => {
        transcribingRef.current = false;
        setTranscribeStatus("");
        const trimmed = fullText.trim();
        if (!trimmed || trimmed === "[inaudible]") {
          maybeAutoSend();
          return;
        }
        if (looksLikeRefusal(trimmed)) {
          chatStatus.value = "transcription unclear \u2014 try again";
          setTimeout(() => {
            if (chatStatus.value === "transcription unclear \u2014 try again") chatStatus.value = "connected";
          }, 3e3);
          maybeAutoSend();
          return;
        }
        insertIntoComposer(trimmed);
      },
      onError: (err) => {
        transcribingRef.current = false;
        setTranscribeStatus("");
        chatStatus.value = `transcription failed: ${err}`;
        setTimeout(() => {
          if (chatStatus.value.startsWith("transcription failed")) chatStatus.value = "connected";
        }, 3e3);
        maybeAutoSend();
      }
    });
  };
  const onMicPointerDown = (ev) => {
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    holdModeRef.current = false;
    holdTimerRef.current = setTimeout(() => {
      holdModeRef.current = true;
      recordingModeRef.current = "mic";
      startRecording(true).catch(console.error);
    }, 300);
  };
  const onMicPointerUp = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdModeRef.current) {
      holdModeRef.current = false;
      finishRecording().catch(console.error);
    } else if (recording) {
      finishRecording().catch(console.error);
    } else {
      recordingModeRef.current = "mic";
      startRecording(true).catch(console.error);
    }
  };
  const onMicPointerCancel = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdModeRef.current || recording) {
      cancelRecording();
      recordingModeRef.current = null;
      holdModeRef.current = false;
    }
  };
  const startAudioAttachRecording = async () => {
    if (recording) return;
    recordingModeRef.current = "attach";
    const ok = await startRecording(false);
    if (!ok) {
      recordingModeRef.current = null;
      chatStatus.value = "microphone unavailable";
      setTimeout(() => {
        if (chatStatus.value === "microphone unavailable") chatStatus.value = "connected";
      }, 3e3);
    }
  };
  const stopAttachRecording = () => {
    if (recordingModeRef.current !== "attach") return;
    finishRecording().catch(console.error);
  };
  const fmtDuration = (ms) => {
    const s5 = Math.floor(ms / 1e3);
    const m6 = Math.floor(s5 / 60);
    const sec = s5 % 60;
    return `${m6}:${sec.toString().padStart(2, "0")}`;
  };
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4(
      "form",
      {
        id: "chat-form",
        onSubmit,
        style: showComposer ? "" : "display:none",
        class: `${composerDisabled ? "ws-down" : ""} ${recording ? "recording" : ""}`,
        children: [
          /* @__PURE__ */ u4("input", { type: "file", id: "chat-file", multiple: true, hidden: true, ref: fileRef, onChange: onFileChange }),
          attachRecording ? /* @__PURE__ */ u4(
            "button",
            {
              type: "button",
              id: "chat-recording-indicator",
              class: "recording-stop-btn",
              onClick: stopAttachRecording,
              title: "Tap to stop recording",
              children: [
                /* @__PURE__ */ u4("span", { class: "recording-dot" }),
                /* @__PURE__ */ u4("span", { class: "recording-time", children: fmtDuration(recordingDuration.value) }),
                /* @__PURE__ */ u4("span", { class: "recording-stop-label", children: "Stop" })
              ]
            }
          ) : /* @__PURE__ */ u4("div", { class: "composer-input-wrap" + (multiLine ? " multi-line" : "") + (recording ? " recording" : "") + (transcribeStatus ? " transcribing" : ""), children: [
            /* @__PURE__ */ u4(
              "textarea",
              {
                id: "chat-input",
                rows: 1,
                placeholder: hasQuestion ? "Answer the question above to continue\u2026" : wsDown ? "Reconnecting\u2026" : "Message the agent\u2026",
                ref: inputRef,
                onInput: autosize,
                onKeyDown: onKey,
                onPaste,
                autocomplete: "off",
                disabled: hasQuestion
              }
            ),
            /* @__PURE__ */ u4(
              ComposerPlusMenu,
              {
                disabled: composerDisabled || recording,
                title: composerDisabled ? hasQuestion ? "Answer the question above" : "Disconnected" : "Add\u2026",
                showRecordAudio: vm === "audio" && hasGetUserMedia(),
                showQuickCapture: hasGetUserMedia(),
                onUploadFile: onAttachClick,
                onQuickCapture: () => setQuickCapture(true),
                onRecordAudio: () => {
                  startAudioAttachRecording().catch(console.error);
                }
              }
            ),
            micCapable ? /* @__PURE__ */ u4(
              "button",
              {
                type: "button",
                id: "chat-mic",
                class: "mic-overlay" + (recording ? " recording" : "") + (transcribeStatus ? " transcribing" : ""),
                title: recording ? "Tap to stop and transcribe" : transcribeStatus ? "Transcribing\u2026" : wsDown ? "Disconnected" : "Hold to record, tap to toggle",
                "aria-label": recording ? "Stop recording" : transcribeStatus ? "Transcribing" : "Record voice message",
                disabled: composerDisabled && !recording || !!transcribeStatus,
                onPointerDown: onMicPointerDown,
                onPointerUp: onMicPointerUp,
                onPointerCancel: onMicPointerCancel,
                children: recording ? /* @__PURE__ */ u4("span", { class: "recording-time", children: fmtDuration(recordingDuration.value) }) : transcribeStatus ? /* @__PURE__ */ u4("span", { class: "mic-spinner", "aria-hidden": "true" }) : "\u{1F399}\uFE0F"
              }
            ) : null,
            /* @__PURE__ */ u4(
              "button",
              {
                type: "submit",
                id: "chat-send",
                "aria-label": "Send",
                title: recording || transcribeStatus ? "Stop, transcribe, and send" : "Send",
                disabled: composerDisabled,
                onMouseDown: (e4) => e4.preventDefault(),
                children: "\u2191"
              }
            )
          ] })
        ]
      }
    ),
    quickCapture ? /* @__PURE__ */ u4(
      QuickCapture,
      {
        onCapture: (file) => {
          setQuickCapture(false);
          addFiles([file]);
        },
        onClose: () => setQuickCapture(false)
      }
    ) : null
  ] });
}
function ReadonlyBanner() {
  const isWeb = !channelType.value || channelType.value === "web";
  const showComposer = isWeb || canSend.value;
  if (showComposer) return /* @__PURE__ */ u4("div", { class: "readonly-banner", hidden: true });
  const meta = channelMeta(channelType.value);
  return /* @__PURE__ */ u4("div", { class: "readonly-banner", children: [
    "Read-only view \u2014 reply on ",
    meta.label,
    " to continue this thread."
  ] });
}
function Subnotice() {
  const isWeb = !channelType.value || channelType.value === "web";
  const showComposer = isWeb || canSend.value;
  if (!(showComposer && !isWeb)) return /* @__PURE__ */ u4("div", { class: "chat-subnotice", hidden: true });
  const meta = channelMeta(channelType.value);
  const t4 = threads.value.find((x6) => x6.threadId === threadId.value);
  const cp = t4 && t4.counterparty ? ` \xB7 ${t4.counterparty}` : "";
  return /* @__PURE__ */ u4("div", { class: "chat-subnotice", children: [
    meta.icon,
    " Sending via ",
    meta.label,
    cp
  ] });
}
function ChatMain() {
  const ref = A2(null);
  y2(() => {
    const el = ref.current;
    if (!el) return void 0;
    let depth = 0;
    const hasFiles = (ev) => !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files");
    const onEnter = (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth++;
      el.classList.add("drag-active");
    };
    const onOver = (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) el.classList.remove("drag-active");
    };
    const onDrop = (ev) => {
      if (!ev.dataTransfer) return;
      ev.preventDefault();
      depth = 0;
      el.classList.remove("drag-active");
      const files = Array.from(ev.dataTransfer.files || []);
      if (files.length > 0) addPendingFiles(files, UPLOAD_MAX_FILES, UPLOAD_MAX_FILE_SIZE, UPLOAD_MAX_TOTAL_SIZE);
    };
    el.addEventListener("dragenter", onEnter);
    el.addEventListener("dragover", onOver);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragenter", onEnter);
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, []);
  return /* @__PURE__ */ u4("section", { class: "chat-main", id: "chat-main", ref, children: [
    /* @__PURE__ */ u4(ApprovalsBanner, {}),
    /* @__PURE__ */ u4(MessageLog, {}),
    /* @__PURE__ */ u4("div", { class: "status", id: "chat-status", children: chatStatus.value }),
    /* @__PURE__ */ u4(ContextChip, {}),
    /* @__PURE__ */ u4(PendingTray, {}),
    /* @__PURE__ */ u4(QuestionCard, {}),
    /* @__PURE__ */ u4(ReadonlyBanner, {}),
    /* @__PURE__ */ u4(Subnotice, {}),
    /* @__PURE__ */ u4(Composer, {})
  ] });
}

// src/uploads.ts
function curDir() {
  return treePath.value || "";
}
function joinPath(dir, name) {
  return dir ? dir + "/" + name : name;
}
function dropPinned(paths) {
  if (paths.length === 0) return;
  pinnedContext.value = pinnedContext.value.filter((p5) => !paths.some((d5) => p5 === d5 || p5.startsWith(d5 + "/")));
}
async function mkdirPrompt() {
  if (!groupId.value || !isAdmin.value) return;
  const name = await requestInput({ title: "New folder", placeholder: "folder name", okLabel: "Create" });
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const target = joinPath(curDir(), trimmed);
  const r4 = await postJson(`api/groups/${groupId.value}/mkdir`, { path: target });
  if (!r4.ok) {
    showToast("mkdir failed: " + (r4.data.error || r4.status), "err");
    return;
  }
  await loadTree(treePath.value);
}
async function renameEntry(entry) {
  if (!isAdmin.value || !groupId.value) return;
  const next = await requestInput({
    title: "Rename",
    placeholder: entry.name,
    initialValue: entry.name,
    okLabel: "Rename"
  });
  if (!next) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === entry.name) return;
  const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
  const toPath = joinPath(dir, trimmed);
  const r4 = await postJson(`api/groups/${groupId.value}/rename`, { from: entry.path, to: toPath });
  if (!r4.ok) {
    showToast("rename failed: " + (r4.data.error || r4.status), "err");
    return;
  }
  pinnedContext.value = pinnedContext.value.map(
    (p5) => p5 === entry.path ? toPath : p5.startsWith(entry.path + "/") ? toPath + p5.slice(entry.path.length) : p5
  );
  await loadTree(treePath.value);
}
async function deleteEntry(entry) {
  if (!isAdmin.value || !groupId.value) return;
  const ok = await requestConfirm({
    title: `Delete ${entry.type === "dir" ? "folder" : "file"}`,
    message: `Delete ${entry.type === "dir" ? "folder" : "file"} "${entry.name}"?`,
    okLabel: "Delete",
    danger: true
  });
  if (!ok) return;
  const r4 = await postJson(`api/groups/${groupId.value}/delete`, { path: entry.path });
  if (!r4.ok) {
    showToast("delete failed: " + (r4.data.error || r4.status), "err");
    return;
  }
  dropPinned([entry.path]);
  await loadTree(treePath.value);
}
async function deletePaths(paths) {
  if (!isAdmin.value || !groupId.value || paths.length === 0) return;
  const ok = await requestConfirm({
    title: "Delete items",
    message: `Delete ${paths.length} item${paths.length === 1 ? "" : "s"}?`,
    okLabel: "Delete",
    danger: true
  });
  if (!ok) return;
  const errors = [];
  const succeeded = [];
  for (const p5 of paths) {
    const r4 = await postJson(`api/groups/${groupId.value}/delete`, { path: p5 });
    if (!r4.ok) errors.push(`${p5}: ${r4.data.error || r4.status}`);
    else succeeded.push(p5);
  }
  if (errors.length) showToast("Some deletes failed:\n" + errors.join("\n"), "err");
  dropPinned(succeeded);
  await loadTree(treePath.value);
}
function downloadPaths(paths, entries) {
  if (!groupId.value || paths.length === 0) return;
  if (paths.length === 1) {
    const single = paths[0];
    const entry = entries?.find((e4) => e4.path === single);
    if (entry && entry.type !== "dir") {
      const segs = String(single || "").split("/").filter(Boolean).map(encodeURIComponent);
      const url = `api/groups/${encodeURIComponent(groupId.value)}/files/${segs.join("/")}`;
      triggerDownload(url, entry.name);
      return;
    }
  }
  const qs = paths.map((p5) => `path=${encodeURIComponent(p5)}`).join("&");
  triggerDownload(`api/groups/${groupId.value}/zip?${qs}`);
}
function triggerDownload(url, filename) {
  const a4 = document.createElement("a");
  a4.href = url;
  if (filename) a4.download = filename;
  a4.rel = "noopener";
  document.body.appendChild(a4);
  a4.click();
  a4.remove();
}
function updateItem(idx, patch) {
  const next = uploadItems.value.slice();
  const cur = next[idx];
  if (!cur) return;
  next[idx] = { ...cur, ...patch };
  uploadItems.value = next;
}
function clearUploadStrip() {
  uploadItems.value = [];
}
function resolveConflict(idx, action) {
  if (action === "skip") {
    updateItem(idx, { status: "error", statusText: "skipped" });
    return;
  }
  updateItem(idx, { status: "uploading", pct: 0, statusText: "uploading\u2026" });
  uploadOne(idx, action).catch(
    (err) => updateItem(idx, {
      status: "error",
      statusText: String(err?.message || err)
    })
  );
}
function uploadOne(idx, mode) {
  return new Promise((resolve) => {
    const item = uploadItems.value[idx];
    if (!item) {
      resolve();
      return;
    }
    const fd = new FormData();
    fd.append("file", item.file, item.name);
    const xhr = new XMLHttpRequest();
    const url = `api/groups/${groupId.value}/upload?path=${encodeURIComponent(curDir())}&mode=${encodeURIComponent(mode)}`;
    xhr.open("POST", url);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) updateItem(idx, { pct: ev.loaded / ev.total * 100 });
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {
      }
      const r4 = body.results && body.results[0] || {};
      if (xhr.status >= 200 && xhr.status < 300 && r4.status === "ok") {
        updateItem(idx, { status: "ok", statusText: "uploaded", path: r4.path ?? null });
      } else if (r4.status === "conflict") {
        updateItem(idx, { status: "conflict", statusText: "file exists" });
      } else {
        updateItem(idx, { status: "error", statusText: r4.reason || r4.status || "http " + xhr.status });
      }
      resolve();
    };
    xhr.onerror = () => {
      updateItem(idx, { status: "error", statusText: "network error" });
      resolve();
    };
    xhr.send(fd);
  });
}
async function uploadFiles(fileList) {
  if (!groupId.value || !isAdmin.value || !fileList || fileList.length === 0) return;
  uploadItems.value = Array.from(fileList).map((file) => ({
    file,
    name: file.name,
    size: file.size,
    status: "uploading",
    pct: 0,
    statusText: "uploading\u2026",
    path: null
  }));
  for (let i5 = 0; i5 < uploadItems.value.length; i5++) {
    await uploadOne(i5, "skip").catch(
      (err) => updateItem(i5, {
        status: "error",
        statusText: String(err?.message || err)
      })
    );
  }
  await loadTree(treePath.value);
}
async function notifyAgent(paths) {
  if (!threadId.value || !groupId.value || paths.length === 0) return;
  const list = paths.slice(0, 20).map((p5) => "`" + p5 + "`").join(", ");
  const more = paths.length > 20 ? ` (and ${paths.length - 20} more)` : "";
  const text = `Files updated via web UI: ${list}${more}`;
  const r4 = await postJson(`api/groups/${groupId.value}/chat/${threadId.value}/send`, { text });
  if (!r4.ok) {
    showToast("notify failed: " + (r4.data.error || r4.status), "err");
    return;
  }
  clearUploadStrip();
}

// src/components/ActionsMenu.tsx
function fileUrl(gid, relPath) {
  const segs = String(relPath || "").split("/").filter(Boolean).map(encodeURIComponent);
  return `api/groups/${encodeURIComponent(gid)}/files/${segs.join("/")}`;
}
function openInNewTab(gid, relPath) {
  if (!gid || !relPath) return;
  window.open(fileUrl(gid, relPath), "_blank", "noopener");
}
async function sharePrivate(gid, entry) {
  if (!gid || !entry?.path) return;
  const url = new URL(fileUrl(gid, entry.path), window.location.href).toString();
  const title = entry.name || entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const navAny = navigator;
  if (navAny.share) {
    try {
      await navAny.share({ title, url });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied");
  } catch {
    showToast("Copy failed", "err");
  }
}
function shareWithToken(gid, entry) {
  if (!gid || !entry?.path) return;
  shareModalRequest.value = { groupId: gid, entry: { path: entry.path, name: entry.name || "", type: entry.type } };
}
function entriesByPath(paths) {
  const set = new Set(paths);
  return treeEntries.value.filter((e4) => set.has(e4.path));
}
function ActionsMenu({ mode, entry, onUpload }) {
  const [open, setOpen] = h2(false);
  const wrapRef = A2(null);
  y2(() => {
    if (!open) return void 0;
    const onDoc = (ev) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target)) setOpen(false);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const items = buildItems(mode, entry, onUpload);
  if (items.length === 0) return null;
  return /* @__PURE__ */ u4("div", { class: "action-menu" + (open ? " open" : ""), ref: wrapRef, children: [
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "text-btn action-trigger",
        "aria-haspopup": "menu",
        "aria-expanded": open,
        title: "Actions",
        onClick: (ev) => {
          ev.stopPropagation();
          setOpen((o4) => !o4);
        },
        children: "\u22EF"
      }
    ),
    open ? /* @__PURE__ */ u4("div", { class: "action-panel", role: "menu", children: items.map((it, i5) => it === "---" ? /* @__PURE__ */ u4("div", { class: "action-sep" }, "s" + i5) : /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "action-item" + (it.danger ? " danger" : ""),
        role: "menuitem",
        disabled: it.disabled,
        onClick: (ev) => {
          ev.stopPropagation();
          setOpen(false);
          it.onClick();
        },
        children: [
          /* @__PURE__ */ u4("span", { class: "ico", children: it.ico }),
          /* @__PURE__ */ u4("span", { class: "lbl", children: it.label })
        ]
      },
      it.label
    )) }) : null
  ] });
}
function buildItems(mode, entry, onUpload) {
  const admin = isAdmin.value;
  const gid = groupId.value;
  if (mode === "row" && entry) {
    const items2 = [];
    items2.push({ ico: "\u2B07", label: "Download", onClick: () => downloadPaths([entry.path], [entry]) });
    if (entry.type !== "dir") {
      items2.push({ ico: "\u2197", label: "Open in new tab", onClick: () => openInNewTab(gid, entry.path) });
      items2.push({ ico: "\u21AA", label: "Share privately", onClick: () => sharePrivate(gid, entry) });
      items2.push({ ico: "\u{1F517}", label: "Share with link\u2026", onClick: () => shareWithToken(gid, entry) });
    }
    if (admin) {
      items2.push("---");
      items2.push({ ico: "\u270E", label: "Rename", onClick: () => renameEntry(entry) });
      items2.push({ ico: "\u{1F5D1}", label: "Delete", danger: true, onClick: () => deleteEntry(entry) });
    }
    return items2;
  }
  if (mode === "preview") {
    const p5 = previewBlock.value;
    const fp = filePath.value;
    if (!p5) return [];
    const entryForPath = treeEntries.value.find((e4) => e4.path === fp) || (fp ? { path: fp, name: p5.name || "", type: "file" } : null);
    const items2 = [];
    items2.push({ ico: "\u21AA", label: "Share privately", onClick: () => sharePrivate(gid, entryForPath), disabled: !fp || !gid });
    items2.push({ ico: "\u{1F517}", label: "Share with link\u2026", onClick: () => shareWithToken(gid, entryForPath), disabled: !fp || !gid });
    items2.push({ ico: "\u2197", label: "Open in new tab", onClick: () => openInNewTab(gid, fp), disabled: !fp || !gid });
    items2.push({ ico: "\u2B07", label: "Download", onClick: () => {
      if (fp && entryForPath) downloadPaths([fp], [entryForPath]);
    }, disabled: !fp });
    if (admin && entryForPath) {
      items2.push("---");
      items2.push({ ico: "\u270E", label: "Rename", onClick: () => renameEntry(entryForPath) });
      items2.push({ ico: "\u{1F5D1}", label: "Delete", danger: true, onClick: () => deleteEntry(entryForPath) });
    }
    return items2;
  }
  const sel = pinnedContext.value;
  const selEntries = entriesByPath(sel);
  const items = [];
  if (admin) {
    items.push({ ico: "\u{1F4C1}", label: "New folder", onClick: mkdirPrompt });
    if (onUpload) items.push({ ico: "\u2B06", label: "Upload files\u2026", onClick: onUpload });
  }
  if (sel.length > 0) {
    if (items.length) items.push("---");
    items.push({ ico: "\u2B07", label: sel.length > 1 ? `Download ${sel.length} (zip)` : "Download", onClick: () => downloadPaths(sel, selEntries) });
    if (admin) {
      if (sel.length === 1 && selEntries.length === 1) {
        items.push({ ico: "\u270E", label: "Rename", onClick: () => renameEntry(selEntries[0]) });
      }
      items.push({ ico: "\u{1F5D1}", label: sel.length > 1 ? `Delete ${sel.length}` : "Delete", danger: true, onClick: () => deletePaths(sel) });
    }
    items.push("---");
    items.push({ ico: "\u2715", label: "Clear selection", onClick: clearPinnedContext });
  }
  return items;
}

// src/components/MediaPlayer.tsx
function MediaPlayer({ kind, url, name, floating }) {
  if (kind !== "audio" && kind !== "video") return null;
  const ref = A2(null);
  y2(() => {
    const el = ref.current;
    if (!el) return void 0;
    const push = () => {
      mediaCurrentTime.value = el.currentTime || 0;
    };
    el.addEventListener("timeupdate", push);
    el.addEventListener("seeked", push);
    el.addEventListener("loadedmetadata", push);
    push();
    return () => {
      el.removeEventListener("timeupdate", push);
      el.removeEventListener("seeked", push);
      el.removeEventListener("loadedmetadata", push);
    };
  }, [url]);
  const cls = "media-player media-player-" + kind + (floating ? " media-player-floating" : "");
  return /* @__PURE__ */ u4("div", { class: cls, children: kind === "audio" ? /* @__PURE__ */ u4("audio", { controls: true, preload: "metadata", src: url, "aria-label": name, ref }) : /* @__PURE__ */ u4("video", { controls: true, preload: "metadata", src: url, "aria-label": name, ref }) });
}

// src/components/LyricsPanel.tsx
var TS_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
var OFFSET_RE = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i;
function parseLyrics(text) {
  const lines = [];
  let sawTimestamp = false;
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const om = OFFSET_RE.exec(raw);
    if (om) {
      offset = Number(om[1]) / 1e3;
      continue;
    }
    const times = [];
    let m6;
    TS_RE.lastIndex = 0;
    while ((m6 = TS_RE.exec(raw)) !== null) {
      const mm = +m6[1];
      const ss = +m6[2];
      const frac = m6[3] ? +`0.${m6[3]}` : 0;
      times.push(mm * 60 + ss + frac);
    }
    const content = raw.replace(TS_RE, "").trim();
    if (times.length === 0) {
      lines.push({ t: null, text: raw });
      continue;
    }
    sawTimestamp = true;
    for (const t4 of times) lines.push({ t: t4, text: content });
  }
  if (!sawTimestamp) return { synced: false, lines, offset: 0 };
  const synced = lines.filter((l7) => l7.t != null).sort((a4, b5) => a4.t - b5.t);
  return { synced: true, lines: synced, offset };
}
function findActiveIdx(lines, t4) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if ((lines[mid].t ?? 0) <= t4) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
function LyricsPanel({ text }) {
  const parsed = T2(() => parseLyrics(text || ""), [text]);
  const [showSynced, setShowSynced] = h2(true);
  const synced = parsed.synced && showSynced;
  const t4 = mediaCurrentTime.value;
  const effective = t4 - parsed.offset;
  const activeIdx = synced ? findActiveIdx(parsed.lines, effective) : -1;
  const scrollerRef = A2(null);
  const activeRef = A2(null);
  const lastIdxRef = A2(-2);
  y2(() => {
    if (lastIdxRef.current === activeIdx) return;
    lastIdxRef.current = activeIdx;
    const el = activeRef.current;
    const c4 = scrollerRef.current;
    if (!el || !c4) return;
    const elRect = el.getBoundingClientRect();
    const cRect = c4.getBoundingClientRect();
    const delta = elRect.top - cRect.top - (c4.clientHeight - el.clientHeight) / 2;
    c4.scrollBy({ top: delta, behavior: "smooth" });
  }, [activeIdx]);
  const seek = (sec) => {
    const media = document.querySelector(".media-player audio, .media-player video");
    if (!media) return;
    const target = Math.max(0, sec + parsed.offset + 0.03);
    media.currentTime = target;
    mediaCurrentTime.value = target;
    const p5 = media.play();
    if (p5 && typeof p5.catch === "function") p5.catch(() => {
    });
  };
  return /* @__PURE__ */ u4("div", { class: "preview-lyrics", ref: scrollerRef, children: [
    parsed.synced ? /* @__PURE__ */ u4("div", { class: "lyrics-toggle", title: synced ? "Show plain text" : "Show synced highlighting", children: /* @__PURE__ */ u4("button", { type: "button", onClick: () => setShowSynced((v5) => !v5), children: synced ? "synced" : "plain" }) }) : null,
    synced ? /* @__PURE__ */ u4("ol", { class: "lyrics-synced", children: parsed.lines.map((l7, i5) => /* @__PURE__ */ u4(
      "li",
      {
        ref: i5 === activeIdx ? activeRef : null,
        class: i5 === activeIdx ? "active" : "",
        onClick: () => seek(l7.t),
        title: `Jump to ${formatTime(l7.t)}`,
        children: l7.text || "\xA0"
      },
      i5
    )) }) : /* @__PURE__ */ u4("pre", { children: text })
  ] });
}
function formatTime(s5) {
  const m6 = Math.floor(s5 / 60);
  const sec = Math.floor(s5 % 60);
  return `${m6}:${String(sec).padStart(2, "0")}`;
}

// node_modules/highlight.js/es/common.js
var import_common = __toESM(require_common(), 1);
var common_default = import_common.default;

// src/highlight.ts
var EXT_LANG = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  json: "json",
  json5: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  xml: "xml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  xhtml: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "makefile",
  mk: "makefile",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  scala: "scala",
  vue: "xml"
};
var BASENAME_LANG = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby"
};
function detectLanguage(name) {
  if (!name) return null;
  const base = (name.split("/").pop() || "").toLowerCase();
  if (BASENAME_LANG[base]) return BASENAME_LANG[base];
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_LANG[base.slice(dot + 1)] || null;
}
function highlightCode(text, name) {
  if (!text) return null;
  const lang = detectLanguage(name);
  try {
    if (lang && common_default.getLanguage(lang)) {
      const r5 = common_default.highlight(text, { language: lang, ignoreIllegals: true });
      return { html: r5.value, language: r5.language || lang };
    }
    const r4 = common_default.highlightAuto(text);
    if (!r4 || !r4.language) return null;
    return { html: r4.value, language: r4.language };
  } catch {
    return null;
  }
}

// src/components/FilesPane.tsx
function Crumb() {
  const ref = A2(null);
  const p5 = treePath.value;
  const fp = filePath.value;
  const segs = p5 ? p5.split("/").filter(Boolean) : [];
  const fileName = fp ? fp.slice(fp.lastIndexOf("/") + 1) : "";
  y2(() => {
    if (ref.current) requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
    });
  }, [p5, fp]);
  let acc = "";
  return /* @__PURE__ */ u4("div", { class: "breadcrumb", id: "crumb", ref, children: [
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "crumb root" + (segs.length === 0 && !fileName ? " current" : ""),
        "data-path": "",
        title: "Root",
        onClick: () => {
          navTree("");
        },
        children: "/"
      }
    ),
    segs.map((s5, i5) => {
      acc = acc ? acc + "/" + s5 : s5;
      const path = acc;
      const last = i5 === segs.length - 1 && !fileName;
      const onClick = last ? void 0 : () => {
        navTree(path);
      };
      return /* @__PURE__ */ u4(k, { children: [
        /* @__PURE__ */ u4("span", { class: "sep", "aria-hidden": "true", children: "\u203A" }),
        /* @__PURE__ */ u4(
          "button",
          {
            type: "button",
            class: "crumb" + (last ? " current" : ""),
            "data-path": path,
            title: "/" + path,
            onClick,
            children: s5
          }
        )
      ] });
    }),
    fileName ? /* @__PURE__ */ u4(k, { children: [
      /* @__PURE__ */ u4("span", { class: "sep", "aria-hidden": "true", children: "\u203A" }),
      /* @__PURE__ */ u4("span", { class: "crumb file current", title: "/" + fp, children: fileName })
    ] }) : null
  ] });
}
function Row({ e: e4 }) {
  const active = e4.path === filePath.value;
  const selected = pinnedContext.value.includes(e4.path);
  const onClick = (ev) => {
    const t4 = ev.target;
    if (t4.closest(".row-sel") || t4.closest(".action-menu")) return;
    if (e4.type === "dir") navTree(e4.path);
    else navFile(e4).catch(console.error);
  };
  return /* @__PURE__ */ u4("div", { class: "row tier-" + e4.tier + (active ? " active" : "") + (selected ? " selected" : ""), "data-path": e4.path, onClick, children: [
    /* @__PURE__ */ u4("label", { class: "row-sel", onClick: (ev) => ev.stopPropagation(), title: selected ? "Detach from next message" : "Attach to next message", children: /* @__PURE__ */ u4("input", { type: "checkbox", checked: selected, onChange: () => togglePinnedFile(e4.path) }) }),
    /* @__PURE__ */ u4("div", { children: e4.type === "dir" ? "\u{1F4C1}" : "\u{1F4C4}" }),
    /* @__PURE__ */ u4("div", { class: "name", children: e4.name }),
    /* @__PURE__ */ u4("div", { class: "size", children: fmtBytes(e4.size) }),
    /* @__PURE__ */ u4("div", { class: "meta", children: /* @__PURE__ */ u4(RelativeTime, { ts: e4.mtime }) }),
    /* @__PURE__ */ u4("div", { class: "row-actions", children: /* @__PURE__ */ u4(ActionsMenu, { mode: "row", entry: e4 }) })
  ] });
}
function Listing() {
  const p5 = treePath.value;
  const err = treeError.value;
  const entries = treeEntries.value;
  if (err) return /* @__PURE__ */ u4("div", { class: "listing", id: "listing", children: /* @__PURE__ */ u4("div", { class: "empty", children: err }) });
  return /* @__PURE__ */ u4("div", { class: "listing", id: "listing", children: [
    p5 ? /* @__PURE__ */ u4("div", { class: "row", onClick: () => navTree(parentPath(p5)), children: /* @__PURE__ */ u4("div", { class: "name", children: ".." }) }) : null,
    entries.length === 0 ? /* @__PURE__ */ u4("div", { class: "empty", children: "Empty directory" }) : entries.map((e4) => /* @__PURE__ */ u4(Row, { e: e4 }, e4.path))
  ] });
}
function UploadStrip() {
  const items = uploadItems.value;
  if (items.length === 0) return /* @__PURE__ */ u4("div", { class: "upload-strip", id: "upload-strip", hidden: true });
  const allDone = items.every((i5) => i5.status !== "uploading");
  const okPaths = items.filter((i5) => i5.status === "ok" && i5.path).map((i5) => i5.path);
  const wakeTitle = !threadId.value ? "Open a thread first" : `Send a message to the agent listing ${okPaths.length} updated file(s)`;
  return /* @__PURE__ */ u4("div", { class: "upload-strip", id: "upload-strip", children: [
    items.map((item, i5) => /* @__PURE__ */ u4("div", { class: "row " + item.status, children: [
      /* @__PURE__ */ u4("div", { class: "name", children: item.name }),
      item.status === "uploading" ? /* @__PURE__ */ u4("div", { class: "bar", children: /* @__PURE__ */ u4("i", { style: `width:${Math.round(item.pct || 0)}%` }) }) : null,
      /* @__PURE__ */ u4("div", { class: "status", children: item.statusText || item.status }),
      item.status === "conflict" ? /* @__PURE__ */ u4("div", { class: "actions", children: [
        /* @__PURE__ */ u4("button", { onClick: () => resolveConflict(i5, "overwrite"), title: "Replace existing file", children: "Overwrite" }),
        /* @__PURE__ */ u4("button", { onClick: () => resolveConflict(i5, "rename"), title: "Save with a unique name", children: "Rename" }),
        /* @__PURE__ */ u4("button", { onClick: () => resolveConflict(i5, "skip"), title: "Cancel this upload", children: "Skip" })
      ] }) : null
    ] }, i5)),
    allDone ? /* @__PURE__ */ u4("div", { class: "footer", children: [
      /* @__PURE__ */ u4(
        "button",
        {
          onClick: () => notifyAgent(okPaths),
          disabled: okPaths.length === 0 || !threadId.value,
          title: wakeTitle,
          children: "Notify agent"
        }
      ),
      /* @__PURE__ */ u4("button", { class: "close", onClick: clearUploadStrip, title: "Dismiss", children: "\u2715" })
    ] }) : null
  ] });
}
function mimeFromKind(kind) {
  switch (kind) {
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "pdf":
      return "application/pdf";
    case "markdown":
      return "text/markdown";
    case "text":
      return "text/plain";
    default:
      return null;
  }
}
function formatMtime(iso) {
  try {
    const d5 = new Date(iso);
    if (Number.isNaN(d5.getTime())) return iso;
    return d5.toLocaleString();
  } catch {
    return iso;
  }
}
function renderMetaPanel(rows) {
  const summary = rows.map(([, v5]) => v5).join(" \xB7 ");
  return /* @__PURE__ */ u4("details", { class: "preview-meta", children: [
    /* @__PURE__ */ u4("summary", { class: "preview-meta-summary", children: summary }),
    /* @__PURE__ */ u4("dl", { class: "preview-meta-rows", children: rows.map(([k4, v5]) => /* @__PURE__ */ u4("div", { class: "row", children: [
      /* @__PURE__ */ u4("dt", { children: k4 }),
      /* @__PURE__ */ u4("dd", { children: v5 })
    ] }, k4)) })
  ] });
}
function Preview() {
  const ref = A2(null);
  const p5 = previewBlock.value;
  if (!p5) return /* @__PURE__ */ u4("div", { class: "preview-body", id: "preview", ref });
  const fp = filePath.value;
  const pinned = !!fp && pinnedContext.value.includes(fp);
  const clippyTitle = pinned ? "Detach from next message" : "Attach to next message";
  const toolbar = /* @__PURE__ */ u4("div", { class: "preview-toolbar", children: [
    /* @__PURE__ */ u4(
      "button",
      {
        class: "text-btn clippy" + (pinned ? " active" : ""),
        onClick: () => togglePinnedFile(fp),
        disabled: !fp,
        title: clippyTitle,
        "aria-pressed": pinned,
        children: "\u{1F4CE}"
      }
    ),
    /* @__PURE__ */ u4("span", { class: "preview-spacer" }),
    /* @__PURE__ */ u4("span", { class: "preview-actions", children: [
      /* @__PURE__ */ u4(
        "button",
        {
          type: "button",
          class: "text-btn refresh-btn",
          onClick: () => {
            if (!p5.name || !fp) return;
            selectFile({ path: fp, name: p5.name }).catch(console.error);
          },
          disabled: !fp || !p5.name,
          title: "Refresh",
          "aria-label": "Refresh",
          children: "\u21BB"
        }
      ),
      /* @__PURE__ */ u4(ActionsMenu, { mode: "preview" }),
      /* @__PURE__ */ u4(
        "button",
        {
          type: "button",
          class: "text-btn close-preview",
          onClick: closePreview,
          title: "Close preview",
          "aria-label": "Close preview",
          children: "\xD7"
        }
      )
    ] })
  ] });
  const fileRows = [];
  if (p5.size != null) fileRows.push(["Size", fmtBytes(p5.size)]);
  const mimeOrKind = p5.mime || mimeFromKind(p5.kind);
  if (mimeOrKind) fileRows.push(["Type", mimeOrKind]);
  if (p5.mtime) fileRows.push(["Modified", formatMtime(p5.mtime)]);
  const tagRows = p5.tags ? Object.entries(p5.tags).map(([k4, v5]) => [k4, String(v5)]) : [];
  const metaRows = [...fileRows, ...tagRows];
  const meta = metaRows.length > 0 ? renderMetaPanel(metaRows) : null;
  const isAudio = p5.kind === "audio";
  const isVideo = p5.kind === "video";
  const player = isAudio || isVideo ? /* @__PURE__ */ u4(MediaPlayer, { kind: p5.kind, url: p5.url || "", name: p5.name || "", floating: isAudio }) : null;
  const lyrics = p5.lyrics ? /* @__PURE__ */ u4(LyricsPanel, { text: p5.lyrics }) : null;
  let body = null;
  if (p5.kind === "image") body = /* @__PURE__ */ u4("img", { alt: p5.name, src: p5.url });
  else if (p5.kind === "pdf") body = /* @__PURE__ */ u4("iframe", { src: p5.url, style: "width:100%;height:90vh;border:0" });
  else if (p5.kind === "markdown") {
    const md = renderMarkdown(p5.text);
    body = md != null ? /* @__PURE__ */ u4("div", { class: "markdown-preview", dangerouslySetInnerHTML: { __html: md } }) : /* @__PURE__ */ u4("pre", { children: p5.text });
  } else if (p5.kind === "text") {
    const hi = highlightCode(p5.text || "", p5.name);
    body = hi ? /* @__PURE__ */ u4("pre", { class: "hljs", "data-lang": hi.language, children: /* @__PURE__ */ u4("code", { dangerouslySetInnerHTML: { __html: hi.html } }) }) : /* @__PURE__ */ u4("pre", { children: p5.text });
  } else if (p5.kind === "binary") body = /* @__PURE__ */ u4("div", { class: "empty", children: [
    "Binary file (",
    p5.mime,
    ")."
  ] });
  else if (p5.kind === "error") body = /* @__PURE__ */ u4("div", { class: "empty", children: p5.text });
  return /* @__PURE__ */ u4("div", { class: "preview-body" + (isAudio ? " has-floating-player" : ""), id: "preview", ref, children: [
    toolbar,
    meta,
    isVideo ? player : null,
    lyrics,
    body,
    isAudio ? player : null
  ] });
}
function FilesPane() {
  const previewing = !!previewBlock.value;
  const bodyRef = A2(null);
  y2(() => {
    const body = bodyRef.current;
    const zone = document.getElementById("dropzone");
    if (!body || !zone) return void 0;
    let depth = 0;
    const hasFiles = (ev) => !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files");
    const highlight = (on2) => {
      zone.classList.toggle("drag-over", !!on2);
    };
    const onEnter = (ev) => {
      if (!isAdmin.value || !hasFiles(ev)) return;
      ev.preventDefault();
      depth++;
      highlight(true);
    };
    const onOver = (ev) => {
      if (!isAdmin.value || !hasFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    };
    const onLeave = () => {
      if (!isAdmin.value) return;
      depth--;
      if (depth <= 0) {
        depth = 0;
        highlight(false);
      }
    };
    const onDrop = (ev) => {
      if (!isAdmin.value) return;
      ev.preventDefault();
      depth = 0;
      highlight(false);
      const files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) uploadFiles(files);
    };
    body.addEventListener("dragenter", onEnter);
    body.addEventListener("dragover", onOver);
    body.addEventListener("dragleave", onLeave);
    body.addEventListener("drop", onDrop);
    return () => {
      body.removeEventListener("dragenter", onEnter);
      body.removeEventListener("dragover", onOver);
      body.removeEventListener("dragleave", onLeave);
      body.removeEventListener("drop", onDrop);
    };
  }, []);
  const uploadInputRef = A2(null);
  const headActions = /* @__PURE__ */ u4("div", { class: "head-actions", children: [
    /* @__PURE__ */ u4(
      "input",
      {
        type: "file",
        id: "upload-input",
        multiple: true,
        hidden: true,
        ref: uploadInputRef,
        onChange: (ev) => {
          const f5 = ev.currentTarget.files;
          if (f5 && f5.length) uploadFiles(f5);
          ev.currentTarget.value = "";
        }
      }
    ),
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "icon-btn refresh-btn",
        title: "Refresh",
        "aria-label": "Refresh",
        onClick: () => {
          loadTree(treePath.peek()).catch(console.error);
        },
        children: "\u21BB"
      }
    ),
    /* @__PURE__ */ u4(ActionsMenu, { mode: "header", onUpload: () => uploadInputRef.current?.click() })
  ] });
  return /* @__PURE__ */ u4(Pane, { paneKey: "files", name: "files-pane", label: "Files", extraClass: previewing ? "previewing" : "", headActions, children: /* @__PURE__ */ u4("div", { class: "files-body", ref: bodyRef, children: [
    /* @__PURE__ */ u4(Crumb, {}),
    /* @__PURE__ */ u4(UploadStrip, {}),
    /* @__PURE__ */ u4(Listing, {}),
    /* @__PURE__ */ u4("div", { class: "drop-hint admin-only", id: "dropzone", children: [
      "Drag & drop files here to upload to ",
      /* @__PURE__ */ u4("code", { id: "dropzone-path", children: [
        "/",
        treePath.value
      ] })
    ] }),
    /* @__PURE__ */ u4(Preview, {})
  ] }) });
}

// src/install.ts
var installAvailable = y3(false);
var installCompleted = y3(false);
var deferred = null;
function initInstall() {
  if (isStandalone()) {
    installCompleted.value = true;
    return;
  }
  window.addEventListener("beforeinstallprompt", (e4) => {
    e4.preventDefault();
    deferred = e4;
    installAvailable.value = true;
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installAvailable.value = false;
    installCompleted.value = true;
  });
}
async function triggerInstall() {
  if (!deferred) return "unavailable";
  try {
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    installAvailable.value = false;
    return outcome;
  } catch {
    return "dismissed";
  }
}
function isStandalone() {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) {
    return true;
  }
  return navigator.standalone === true;
}

// src/modalBackButton.ts
var MARKER = "__modal_back__";
function useBackButtonCloses(open, onClose) {
  const pushedRef = A2(false);
  y2(() => {
    if (!open) {
      if (pushedRef.current) {
        pushedRef.current = false;
        history.back();
      }
      return void 0;
    }
    history.pushState({ [MARKER]: true }, "", location.href);
    pushedRef.current = true;
    const onPop = () => {
      pushedRef.current = false;
      onClose();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open]);
}

// src/components/Settings.tsx
var API = "/ui/settings/api";
async function jget(p5) {
  const r4 = await fetch(p5, { credentials: "same-origin" });
  return { ok: r4.ok, status: r4.status, data: await r4.json().catch(() => ({})) };
}
async function jsend(p5, method, body) {
  const r4 = await fetch(p5, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : void 0
  });
  return { ok: r4.ok, status: r4.status, data: await r4.json().catch(() => ({})) };
}
function chanLabel(c4) {
  const m6 = CHANNEL_META[c4];
  return m6 ? `${m6.icon} ${m6.label}` : c4;
}
function Settings() {
  const open = settingsOpen.value;
  const [identities, setIdentities] = h2([]);
  const [channels, setChannels] = h2([]);
  const [deepLinkChannels, setDeepLinkChannels] = h2([]);
  const [chan, setChan] = h2("");
  const [handle, setHandle] = h2("");
  const [code, setCode] = h2("");
  const [challenge, setChallenge] = h2(null);
  const [deepLink, setDeepLink] = h2(null);
  const [status, setStatus] = h2(null);
  const [busy, setBusy] = h2(false);
  const [displayName, setDisplayName] = h2("");
  const [savedDisplayName, setSavedDisplayName] = h2("");
  const [savingProfile, setSavingProfile] = h2(false);
  async function refresh() {
    const r4 = await jget(`${API}/identities`);
    if (!r4.ok) {
      setStatus({ err: r4.data?.error || `HTTP ${r4.status}` });
      return;
    }
    setIdentities(r4.data.identities || []);
    setDeepLinkChannels(r4.data.deepLinkChannels || []);
    const linked = new Set((r4.data.identities || []).map((i5) => i5.channel));
    const available = Array.isArray(r4.data.availableChannels) ? r4.data.availableChannels : Object.keys(CHANNEL_META);
    const opts = available.filter((c4) => c4 !== "web" && c4 !== "cli" && !linked.has(c4));
    setChannels(opts);
    if (opts.length && !opts.includes(chan)) setChan(opts[0]);
  }
  y2(() => {
    if (!open) return;
    setStatus(null);
    setChallenge(null);
    setDeepLink(null);
    setCode("");
    refresh();
    (async () => {
      const r4 = await jget(`${API}/profile`);
      if (r4.ok) {
        const name = (r4.data.displayName || "").trim();
        setDisplayName(name);
        setSavedDisplayName(name);
      }
    })();
  }, [open]);
  async function saveProfile() {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed === savedDisplayName) return;
    setSavingProfile(true);
    setStatus(null);
    try {
      const r4 = await jsend(`${API}/profile`, "PATCH", { displayName: trimmed });
      if (!r4.ok) {
        setStatus({ err: r4.data.message || r4.data.error || `HTTP ${r4.status}` });
        return;
      }
      const next = (r4.data.displayName || trimmed).trim();
      setDisplayName(next);
      setSavedDisplayName(next);
      me.value = next;
      showToast("Display name updated");
    } finally {
      setSavingProfile(false);
    }
  }
  async function startLink() {
    if (!handle.trim()) {
      setStatus({ err: "Enter a handle." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const r4 = await jsend(`${API}/identities/link/start`, "POST", { channel: chan, handle: handle.trim() });
      if (!r4.ok) {
        setStatus({ err: r4.data.message || r4.data.error || `HTTP ${r4.status}` });
        return;
      }
      setChallenge({ id: r4.data.challengeId, channel: r4.data.channel, handle: r4.data.handle, expiresAt: r4.data.expiresAt });
      setStatus({ ok: `Code DM'd to ${r4.data.channel}:${r4.data.handle}.` });
    } finally {
      setBusy(false);
    }
  }
  async function startDeepLink() {
    setBusy(true);
    setStatus(null);
    try {
      const r4 = await jsend(`${API}/identities/link/start-deeplink`, "POST", { channel: chan });
      if (!r4.ok) {
        setStatus({ err: r4.data.message || r4.data.error || `HTTP ${r4.status}` });
        return;
      }
      setDeepLink({ id: r4.data.challengeId, channel: r4.data.channel, url: r4.data.deepLink || "", expiresAt: r4.data.expiresAt });
      window.open(r4.data.deepLink, "_blank", "noopener");
      setStatus({ ok: `Opened ${chanLabel(r4.data.channel)}. Confirm the link there, then come back.` });
    } finally {
      setBusy(false);
    }
  }
  y2(() => {
    if (!deepLink) return void 0;
    const t4 = setInterval(async () => {
      const r4 = await jget(`${API}/identities/link/status?challengeId=${encodeURIComponent(deepLink.id)}`);
      if (!r4.ok) return;
      if (r4.data.consumed) {
        setStatus({ ok: `Linked ${r4.data.channel}:${r4.data.handle}.` });
        setDeepLink(null);
        refresh();
      } else if (r4.data.expired) {
        setStatus({ err: "Link expired \u2014 try again." });
        setDeepLink(null);
      }
    }, 2e3);
    return () => clearInterval(t4);
  }, [deepLink]);
  async function verify() {
    if (!challenge || !code.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const r4 = await jsend(`${API}/identities/link/verify`, "POST", { challengeId: challenge.id, code: code.trim() });
      if (!r4.ok) {
        const left = r4.data.attemptsRemaining != null ? ` (${r4.data.attemptsRemaining} attempts left)` : "";
        setStatus({ err: (r4.data.message || r4.data.error || `HTTP ${r4.status}`) + left });
        return;
      }
      setStatus({ ok: `Linked ${r4.data.channel}:${r4.data.handle}.` });
      setChallenge(null);
      setHandle("");
      setCode("");
      refresh();
    } finally {
      setBusy(false);
    }
  }
  async function unlink(channel, h5) {
    const ok = await requestConfirm({
      title: "Unlink identity",
      message: `Unlink ${channel}:${h5}?`,
      okLabel: "Unlink",
      danger: true
    });
    if (!ok) return;
    const r4 = await jsend(`${API}/identities/${encodeURIComponent(channel)}/${encodeURIComponent(h5)}`, "DELETE");
    if (!r4.ok) {
      setStatus({ err: r4.data.message || r4.data.error || `HTTP ${r4.status}` });
      return;
    }
    setStatus({ ok: `Unlinked ${channel}:${h5}.` });
    refresh();
  }
  function close() {
    settingsOpen.value = false;
  }
  function onBackdrop(e4) {
    if (e4.target.classList.contains("settings-backdrop")) close();
  }
  function onKey(e4) {
    if (e4.key === "Escape") close();
  }
  useBackButtonCloses(open, close);
  y2(() => {
    if (!open) return void 0;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  const muted = notifMutedSig.value;
  return /* @__PURE__ */ u4("div", { class: "settings-backdrop", onClick: onBackdrop, children: /* @__PURE__ */ u4("div", { class: "settings-modal", role: "dialog", "aria-label": "Settings", children: [
    /* @__PURE__ */ u4("header", { class: "settings-head", children: [
      /* @__PURE__ */ u4("span", { class: "title", children: "Settings" }),
      /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: close, children: "\u2715" })
    ] }),
    /* @__PURE__ */ u4("div", { class: "settings-body", children: [
      /* @__PURE__ */ u4("section", { children: [
        /* @__PURE__ */ u4("h3", { children: "Profile" }),
        /* @__PURE__ */ u4("div", { class: "settings-row", children: [
          /* @__PURE__ */ u4(
            "input",
            {
              type: "text",
              placeholder: "Display name",
              maxlength: 80,
              value: displayName,
              onInput: (e4) => setDisplayName(e4.currentTarget.value)
            }
          ),
          /* @__PURE__ */ u4(
            "button",
            {
              onClick: saveProfile,
              disabled: savingProfile || !displayName.trim() || displayName.trim() === savedDisplayName,
              children: "Save"
            }
          )
        ] }),
        /* @__PURE__ */ u4("p", { class: "muted", children: [
          "Shown in ",
          BRAND.name,
          " chat headers and approval messages. Does not change how channels address you."
        ] })
      ] }),
      /* @__PURE__ */ u4("section", { children: [
        /* @__PURE__ */ u4("h3", { children: "Notifications" }),
        /* @__PURE__ */ u4("label", { class: "settings-row", children: [
          /* @__PURE__ */ u4("input", { type: "checkbox", checked: !muted, onChange: toggleMute }),
          /* @__PURE__ */ u4("span", { children: "Browser notifications for new messages" })
        ] }),
        /* @__PURE__ */ u4("p", { class: "muted", children: muted ? "Currently muted. New messages will not raise notifications." : "Enabled. Permission is requested on first toggle." })
      ] }),
      /* @__PURE__ */ u4("section", { children: [
        /* @__PURE__ */ u4("h3", { children: "Sounds" }),
        /* @__PURE__ */ u4("label", { class: "settings-row", children: [
          /* @__PURE__ */ u4(
            "input",
            {
              type: "checkbox",
              checked: !progressSoundMutedSig.value,
              onChange: () => {
                progressSoundMutedSig.value = !progressSoundMutedSig.value;
              }
            }
          ),
          /* @__PURE__ */ u4("span", { children: "Play a sound as the agent makes progress" })
        ] }),
        /* @__PURE__ */ u4("p", { class: "muted", children: "A subtle tick when the agent runs a tool or moves to a new step." })
      ] }),
      /* @__PURE__ */ u4("section", { children: [
        /* @__PURE__ */ u4("h3", { children: "Completion sound" }),
        /* @__PURE__ */ u4("label", { class: "settings-row", children: [
          /* @__PURE__ */ u4(
            "input",
            {
              type: "checkbox",
              checked: !completionSoundMutedSig.value,
              onChange: () => {
                completionSoundMutedSig.value = !completionSoundMutedSig.value;
              }
            }
          ),
          /* @__PURE__ */ u4("span", { children: "Play a chime when the agent's reply arrives" })
        ] }),
        /* @__PURE__ */ u4("p", { class: "muted", children: "A short chime each time the agent finishes and sends its response." })
      ] }),
      /* @__PURE__ */ u4(InstallSection, {}),
      /* @__PURE__ */ u4("section", { children: [
        /* @__PURE__ */ u4("h3", { children: "Linked identities" }),
        /* @__PURE__ */ u4("p", { class: "muted", children: [
          "Identities let ",
          BRAND.name,
          " recognize you across channels. Add more so any channel you DM the bot from is treated as the same user. The ",
          /* @__PURE__ */ u4("em", { children: "primary" }),
          " identity is where ",
          BRAND.name,
          " reaches out when it needs to message you first (approval prompts, pairing, host notifications); replies always go back through whichever channel you wrote from."
        ] }),
        identities.length === 0 ? /* @__PURE__ */ u4("p", { class: "muted", children: "No identities yet." }) : /* @__PURE__ */ u4("table", { class: "settings-table", children: [
          /* @__PURE__ */ u4("thead", { children: /* @__PURE__ */ u4("tr", { children: [
            /* @__PURE__ */ u4("th", { children: "Channel" }),
            /* @__PURE__ */ u4("th", { children: "Handle" }),
            /* @__PURE__ */ u4("th", { title: "Where the bot reaches you when it initiates a DM (approvals, pairing, host notifications). Replies follow whichever channel you wrote from.", children: "Primary" }),
            /* @__PURE__ */ u4("th", {})
          ] }) }),
          /* @__PURE__ */ u4("tbody", { children: identities.map((i5) => /* @__PURE__ */ u4("tr", { children: [
            /* @__PURE__ */ u4("td", { children: chanLabel(i5.channel) }),
            /* @__PURE__ */ u4("td", { children: /* @__PURE__ */ u4("code", { children: i5.handle }) }),
            /* @__PURE__ */ u4("td", { children: i5.primary ? "yes" : "" }),
            /* @__PURE__ */ u4("td", { children: identities.length > 1 ? /* @__PURE__ */ u4("button", { class: "danger", onClick: () => unlink(i5.channel, i5.handle), children: "Unlink" }) : /* @__PURE__ */ u4("span", { class: "muted", children: "last" }) })
          ] }, i5.channel + ":" + i5.handle)) })
        ] }),
        /* @__PURE__ */ u4("h4", { children: "Link a new identity" }),
        channels.length === 0 ? /* @__PURE__ */ u4("p", { class: "muted", children: "No additional channels available." }) : deepLinkChannels.includes(chan) ? /* @__PURE__ */ u4(k, { children: [
          /* @__PURE__ */ u4("div", { class: "settings-row", children: [
            /* @__PURE__ */ u4("select", { value: chan, onChange: (e4) => {
              setChan(e4.currentTarget.value);
              setDeepLink(null);
              setChallenge(null);
              setStatus(null);
            }, children: channels.map((c4) => /* @__PURE__ */ u4("option", { value: c4, children: chanLabel(c4) }, c4)) }),
            /* @__PURE__ */ u4("button", { onClick: startDeepLink, disabled: busy || !!deepLink, children: [
              "Open ",
              chanLabel(chan),
              " to confirm"
            ] })
          ] }),
          deepLink ? /* @__PURE__ */ u4("div", { class: "settings-row", style: "margin-top:8px", children: [
            /* @__PURE__ */ u4("a", { href: deepLink.url, target: "_blank", rel: "noopener", children: "Reopen link" }),
            /* @__PURE__ */ u4("button", { class: "ghost", onClick: () => {
              setDeepLink(null);
              setStatus(null);
            }, children: "Cancel" }),
            /* @__PURE__ */ u4("span", { class: "muted", children: [
              "expires ",
              new Date(deepLink.expiresAt).toLocaleTimeString()
            ] })
          ] }) : null
        ] }) : /* @__PURE__ */ u4(k, { children: [
          /* @__PURE__ */ u4("div", { class: "settings-row", children: [
            /* @__PURE__ */ u4("select", { value: chan, onChange: (e4) => {
              setChan(e4.currentTarget.value);
              setDeepLink(null);
              setChallenge(null);
              setStatus(null);
            }, children: channels.map((c4) => /* @__PURE__ */ u4("option", { value: c4, children: chanLabel(c4) }, c4)) }),
            /* @__PURE__ */ u4("input", { placeholder: "handle", value: handle, onInput: (e4) => setHandle(e4.currentTarget.value) }),
            /* @__PURE__ */ u4("button", { onClick: startLink, disabled: busy || !!challenge, children: "Send code" })
          ] }),
          challenge ? /* @__PURE__ */ u4("div", { class: "settings-row", style: "margin-top:8px", children: [
            /* @__PURE__ */ u4("input", { placeholder: "6-digit code", maxlength: 6, value: code, onInput: (e4) => setCode(e4.currentTarget.value), style: "width:120px" }),
            /* @__PURE__ */ u4("button", { onClick: verify, disabled: busy || !code.trim(), children: "Verify" }),
            /* @__PURE__ */ u4("button", { class: "ghost", onClick: () => {
              setChallenge(null);
              setCode("");
              setStatus(null);
            }, children: "Cancel" }),
            /* @__PURE__ */ u4("span", { class: "muted", children: [
              "expires ",
              new Date(challenge.expiresAt).toLocaleTimeString()
            ] })
          ] }) : null
        ] })
      ] }),
      status ? /* @__PURE__ */ u4("div", { class: "settings-status " + (status.err ? "err" : "ok"), children: status.err || status.ok }) : null,
      /* @__PURE__ */ u4("section", { class: "settings-account", children: [
        me.value ? /* @__PURE__ */ u4("span", { class: "settings-account-name", children: me.value }) : null,
        /* @__PURE__ */ u4("form", { method: "POST", action: "/ui/auth/logout", style: "margin:0", children: /* @__PURE__ */ u4("button", { type: "submit", children: "Log out" }) })
      ] })
    ] })
  ] }) });
}
function InstallSection() {
  const canInstall = installAvailable.value;
  const installed = installCompleted.value;
  const iosNeedsHint = !installed && !canInstall && shouldShowIosInstallHint();
  if (!canInstall && !installed && !iosNeedsHint) return null;
  async function onInstall() {
    const outcome = await triggerInstall();
    if (outcome === "accepted") showToast("Installing\u2026");
    else if (outcome === "dismissed") showToast("Install canceled", "err");
  }
  return /* @__PURE__ */ u4("section", { children: [
    /* @__PURE__ */ u4("h3", { children: "Install app" }),
    installed ? /* @__PURE__ */ u4("p", { class: "muted", children: [
      BRAND.name,
      " is installed and running as an app."
    ] }) : canInstall ? /* @__PURE__ */ u4(k, { children: [
      /* @__PURE__ */ u4("button", { type: "button", onClick: onInstall, children: [
        "Install ",
        BRAND.name
      ] }),
      /* @__PURE__ */ u4("p", { class: "muted", children: [
        "Adds ",
        BRAND.name,
        " to your home screen / app launcher and runs it in its own window."
      ] })
    ] }) : /* @__PURE__ */ u4("p", { class: "muted", children: [
      "Tap the Share button in Safari, then ",
      /* @__PURE__ */ u4("em", { children: "Add to Home Screen" }),
      " to install ",
      BRAND.name,
      " as an app."
    ] })
  ] });
}

// src/components/ShareLinkModal.tsx
var DURATIONS = [
  { label: "15 minutes", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "1 day", minutes: 60 * 24 },
  { label: "7 days", minutes: 60 * 24 * 7 }
];
function ShareLinkModal() {
  const req = shareModalRequest.value;
  const [ttl, setTtl] = h2(60);
  const [uses, setUses] = h2(1);
  const [busy, setBusy] = h2(false);
  const [result, setResult] = h2(null);
  const [error, setError] = h2(null);
  const urlRef = A2(null);
  y2(() => {
    if (!req) return;
    setTtl(60);
    setUses(1);
    setBusy(false);
    setResult(null);
    setError(null);
  }, [req?.entry?.path, req?.groupId]);
  y2(() => {
    if (!req) return void 0;
    const onKey = (e4) => {
      if (e4.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  const { groupId: groupId2, entry } = req;
  const title = entry?.name || (entry?.path || "").slice((entry?.path || "").lastIndexOf("/") + 1);
  function close() {
    shareModalRequest.value = null;
  }
  function onBackdrop(e4) {
    if (e4.target.classList.contains("settings-backdrop")) close();
  }
  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const r4 = await postJson(`api/groups/${encodeURIComponent(groupId2)}/share-token`, {
        path: entry.path,
        ttlMinutes: ttl,
        uses
      });
      if (!r4.ok) {
        setError(r4.data.error || `HTTP ${r4.status}`);
        return;
      }
      setResult(r4.data);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!result?.url) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(result.url);
      ok = true;
    } catch {
      if (urlRef.current) {
        urlRef.current.select();
        try {
          ok = document.execCommand("copy");
        } catch {
        }
      }
    }
    showToast(ok ? "Link copied" : "Copy failed", ok ? "ok" : "err");
  }
  async function shareSystem() {
    const navAny2 = navigator;
    if (!result?.url || !navAny2.share) return;
    try {
      await navAny2.share({ title, url: result.url });
    } catch (err) {
      if (err && err.name !== "AbortError") setError(String(err));
    }
  }
  const expiresLabel = result?.expiresAt ? new Date(result.expiresAt).toLocaleString() : null;
  const navAny = navigator;
  return /* @__PURE__ */ u4("div", { class: "settings-backdrop", onClick: onBackdrop, children: /* @__PURE__ */ u4("div", { class: "settings-modal", role: "dialog", "aria-label": "Share with link", style: "max-width:520px", children: [
    /* @__PURE__ */ u4("header", { class: "settings-head", children: [
      /* @__PURE__ */ u4("span", { class: "title", children: "Share with link" }),
      /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: close, children: "\u2715" })
    ] }),
    /* @__PURE__ */ u4("div", { class: "settings-body", children: [
      /* @__PURE__ */ u4("p", { class: "muted", style: "margin-top:0", children: [
        "Anyone with this link can download ",
        /* @__PURE__ */ u4("code", { children: title }),
        " until it expires or the use count is exhausted. No sign-in required."
      ] }),
      result ? /* @__PURE__ */ u4("section", { children: [
        /* @__PURE__ */ u4("h3", { children: "Link ready" }),
        /* @__PURE__ */ u4("div", { class: "settings-row", children: /* @__PURE__ */ u4(
          "input",
          {
            ref: urlRef,
            type: "text",
            readonly: true,
            value: result.url,
            onClick: (e4) => e4.currentTarget.select()
          }
        ) }),
        /* @__PURE__ */ u4("p", { class: "muted", children: [
          "Valid for ",
          result.ttlMinutes,
          " min",
          expiresLabel ? ` (until ${expiresLabel})` : "",
          ",",
          " ",
          result.uses,
          " download",
          result.uses === 1 ? "" : "s",
          "."
        ] }),
        /* @__PURE__ */ u4("div", { class: "settings-row", children: [
          /* @__PURE__ */ u4("button", { type: "button", onClick: copy, children: "Copy link" }),
          navAny.share ? /* @__PURE__ */ u4("button", { type: "button", class: "ghost", onClick: shareSystem, children: [
            "Share",
            "\u2026"
          ] }) : null,
          /* @__PURE__ */ u4("button", { type: "button", class: "ghost", onClick: () => setResult(null), children: "Mint another" })
        ] })
      ] }) : /* @__PURE__ */ u4("section", { children: [
        /* @__PURE__ */ u4("h3", { children: "Valid for" }),
        /* @__PURE__ */ u4("div", { class: "settings-row", children: [
          /* @__PURE__ */ u4("select", { value: ttl, onChange: (e4) => setTtl(Number(e4.currentTarget.value)), children: DURATIONS.map((d5) => /* @__PURE__ */ u4("option", { value: d5.minutes, children: d5.label }, d5.minutes)) }),
          /* @__PURE__ */ u4("span", { class: "muted", children: "or custom (minutes):" }),
          /* @__PURE__ */ u4(
            "input",
            {
              type: "number",
              min: 1,
              max: 10080,
              value: ttl,
              onInput: (e4) => setTtl(Math.max(1, Math.min(10080, Number(e4.currentTarget.value) || 1)))
            }
          )
        ] }),
        /* @__PURE__ */ u4("p", { class: "muted", children: "Maximum 7 days (10080 minutes)." }),
        /* @__PURE__ */ u4("h3", { children: "Number of downloads" }),
        /* @__PURE__ */ u4("div", { class: "settings-row", children: [
          /* @__PURE__ */ u4(
            "input",
            {
              type: "number",
              min: 1,
              max: 100,
              value: uses,
              onInput: (e4) => setUses(Math.max(1, Math.min(100, Number(e4.currentTarget.value) || 1)))
            }
          ),
          /* @__PURE__ */ u4("button", { type: "button", class: "ghost", onClick: () => setUses(1), disabled: uses === 1, children: "Single use" })
        ] }),
        /* @__PURE__ */ u4("p", { class: "muted", children: "Maximum 100. The link stops working once exhausted." })
      ] }),
      error ? /* @__PURE__ */ u4("div", { class: "settings-status err", children: error }) : null
    ] }),
    /* @__PURE__ */ u4("div", { class: "settings-row", style: "padding:10px 16px;border-top:1px solid var(--border);justify-content:flex-end", children: result ? /* @__PURE__ */ u4("button", { type: "button", onClick: close, children: "Done" }) : /* @__PURE__ */ u4(k, { children: [
      /* @__PURE__ */ u4("button", { type: "button", class: "ghost", onClick: close, disabled: busy, children: "Cancel" }),
      /* @__PURE__ */ u4("button", { type: "button", onClick: mint, disabled: busy, children: busy ? "Creating\u2026" : "Create link" })
    ] }) })
  ] }) });
}

// node_modules/preact/compat/dist/compat.module.js
function g7(n3, t4) {
  for (var e4 in t4) n3[e4] = t4[e4];
  return n3;
}
function E4(n3, t4) {
  for (var e4 in n3) if ("__source" !== e4 && !(e4 in t4)) return true;
  for (var r4 in t4) if ("__source" !== r4 && n3[r4] !== t4[r4]) return true;
  return false;
}
function N3(n3, t4) {
  this.props = n3, this.context = t4;
}
(N3.prototype = new x()).isPureReactComponent = true, N3.prototype.shouldComponentUpdate = function(n3, t4) {
  return E4(this.props, n3) || E4(this.state, t4);
};
var T4 = l.__b;
l.__b = function(n3) {
  n3.type && n3.type.__f && n3.ref && (n3.props.ref = n3.ref, n3.ref = null), T4 && T4(n3);
};
var A5 = "undefined" != typeof Symbol && Symbol.for && Symbol.for("react.forward_ref") || 3911;
var F4 = l.__e;
l.__e = function(n3, t4, e4, r4) {
  if (n3.then) {
    for (var u5, o4 = t4; o4 = o4.__; ) if ((u5 = o4.__c) && u5.__c) return null == t4.__e && (t4.__e = e4.__e, t4.__k = e4.__k), u5.__c(n3, t4);
  }
  F4(n3, t4, e4, r4);
};
var U2 = l.unmount;
function V3(n3, t4, e4) {
  return n3 && (n3.__c && n3.__c.__H && (n3.__c.__H.__.forEach(function(n4) {
    "function" == typeof n4.__c && n4.__c();
  }), n3.__c.__H = null), null != (n3 = g7({}, n3)).__c && (n3.__c.__P === e4 && (n3.__c.__P = t4), n3.__c = null), n3.__k = n3.__k && n3.__k.map(function(n4) {
    return V3(n4, t4, e4);
  })), n3;
}
function W2(n3, t4, e4) {
  return n3 && e4 && (n3.__v = null, n3.__k = n3.__k && n3.__k.map(function(n4) {
    return W2(n4, t4, e4);
  }), n3.__c && n3.__c.__P === t4 && (n3.__e && e4.appendChild(n3.__e), n3.__c.__e = true, n3.__c.__P = e4)), n3;
}
function P4() {
  this.__u = 0, this.o = null, this.__b = null;
}
function j5(n3) {
  var t4 = n3.__.__c;
  return t4 && t4.__a && t4.__a(n3);
}
function B4() {
  this.i = null, this.l = null;
}
l.unmount = function(n3) {
  var t4 = n3.__c;
  t4 && t4.__R && t4.__R(), t4 && 32 & n3.__u && (n3.type = null), U2 && U2(n3);
}, (P4.prototype = new x()).__c = function(n3, t4) {
  var e4 = t4.__c, r4 = this;
  null == r4.o && (r4.o = []), r4.o.push(e4);
  var u5 = j5(r4.__v), o4 = false, i5 = function() {
    o4 || (o4 = true, e4.__R = null, u5 ? u5(c4) : c4());
  };
  e4.__R = i5;
  var c4 = function() {
    if (!--r4.__u) {
      if (r4.state.__a) {
        var n4 = r4.state.__a;
        r4.__v.__k[0] = W2(n4, n4.__c.__P, n4.__c.__O);
      }
      var t5;
      for (r4.setState({ __a: r4.__b = null }); t5 = r4.o.pop(); ) t5.forceUpdate();
    }
  };
  r4.__u++ || 32 & t4.__u || r4.setState({ __a: r4.__b = r4.__v.__k[0] }), n3.then(i5, i5);
}, P4.prototype.componentWillUnmount = function() {
  this.o = [];
}, P4.prototype.render = function(n3, e4) {
  if (this.__b) {
    if (this.__v.__k) {
      var r4 = document.createElement("div"), o4 = this.__v.__k[0].__c;
      this.__v.__k[0] = V3(this.__b, r4, o4.__O = o4.__P);
    }
    this.__b = null;
  }
  var i5 = e4.__a && g(k, null, n3.fallback);
  return i5 && (i5.__u &= -33), [g(k, null, e4.__a ? null : n3.children), i5];
};
var H3 = function(n3, t4, e4) {
  if (++e4[1] === e4[0] && n3.l.delete(t4), n3.props.revealOrder && ("t" !== n3.props.revealOrder[0] || !n3.l.size)) for (e4 = n3.i; e4; ) {
    for (; e4.length > 3; ) e4.pop()();
    if (e4[1] < e4[0]) break;
    n3.i = e4 = e4[2];
  }
};
function Z2(n3) {
  return this.getChildContext = function() {
    return n3.context;
  }, n3.children;
}
function Y2(n3) {
  var e4 = this, r4 = n3.h;
  e4.componentWillUnmount = function() {
    D(null, e4.v), e4.v = null, e4.h = null;
  }, e4.h && e4.h !== r4 && e4.componentWillUnmount(), e4.v || (e4.h = r4, e4.v = { nodeType: 1, parentNode: r4, childNodes: [], contains: function() {
    return true;
  }, appendChild: function(n4) {
    this.childNodes.push(n4), e4.h.appendChild(n4);
  }, insertBefore: function(n4, t4) {
    this.childNodes.push(n4), e4.h.insertBefore(n4, t4);
  }, removeChild: function(n4) {
    this.childNodes.splice(this.childNodes.indexOf(n4) >>> 1, 1), e4.h.removeChild(n4);
  } }), D(g(Z2, { context: e4.context }, n3.__v), e4.v);
}
function $3(n3, e4) {
  var r4 = g(Y2, { __v: n3, h: e4 });
  return r4.containerInfo = e4, r4;
}
(B4.prototype = new x()).__a = function(n3) {
  var t4 = this, e4 = j5(t4.__v), r4 = t4.l.get(n3);
  return r4[0]++, function(u5) {
    var o4 = function() {
      t4.props.revealOrder ? (r4.push(u5), H3(t4, n3, r4)) : u5();
    };
    e4 ? e4(o4) : o4();
  };
}, B4.prototype.render = function(n3) {
  this.i = null, this.l = /* @__PURE__ */ new Map();
  var t4 = H(n3.children);
  n3.revealOrder && "b" === n3.revealOrder[0] && t4.reverse();
  for (var e4 = t4.length; e4--; ) this.l.set(t4[e4], this.i = [1, 0, this.i]);
  return n3.children;
}, B4.prototype.componentDidUpdate = B4.prototype.componentDidMount = function() {
  var n3 = this;
  this.l.forEach(function(t4, e4) {
    H3(n3, e4, t4);
  });
};
var q4 = "undefined" != typeof Symbol && Symbol.for && Symbol.for("react.element") || 60103;
var G2 = /^(?:accent|alignment|arabic|baseline|cap|clip(?!PathU)|color|dominant|fill|flood|font|glyph(?!R)|horiz|image(!S)|letter|lighting|marker(?!H|W|U)|overline|paint|pointer|shape|stop|strikethrough|stroke|text(?!L)|transform|underline|unicode|units|v|vector|vert|word|writing|x(?!C))[A-Z]/;
var J3 = /^on(Ani|Tra|Tou|BeforeInp|Compo)/;
var K2 = /[A-Z0-9]/g;
var Q2 = "undefined" != typeof document;
var X2 = function(n3) {
  return ("undefined" != typeof Symbol && "symbol" == typeof Symbol() ? /fil|che|rad/ : /fil|che|ra/).test(n3);
};
x.prototype.isReactComponent = {}, ["componentWillMount", "componentWillReceiveProps", "componentWillUpdate"].forEach(function(t4) {
  Object.defineProperty(x.prototype, t4, { configurable: true, get: function() {
    return this["UNSAFE_" + t4];
  }, set: function(n3) {
    Object.defineProperty(this, t4, { configurable: true, writable: true, value: n3 });
  } });
});
var en = l.event;
function rn() {
}
function un() {
  return this.cancelBubble;
}
function on() {
  return this.defaultPrevented;
}
l.event = function(n3) {
  return en && (n3 = en(n3)), n3.persist = rn, n3.isPropagationStopped = un, n3.isDefaultPrevented = on, n3.nativeEvent = n3;
};
var cn;
var ln = { enumerable: false, configurable: true, get: function() {
  return this.class;
} };
var fn = l.vnode;
l.vnode = function(n3) {
  "string" == typeof n3.type && function(n4) {
    var t4 = n4.props, e4 = n4.type, u5 = {}, o4 = -1 === e4.indexOf("-");
    for (var i5 in t4) {
      var c4 = t4[i5];
      if (!("value" === i5 && "defaultValue" in t4 && null == c4 || Q2 && "children" === i5 && "noscript" === e4 || "class" === i5 || "className" === i5)) {
        var l7 = i5.toLowerCase();
        "defaultValue" === i5 && "value" in t4 && null == t4.value ? i5 = "value" : "download" === i5 && true === c4 ? c4 = "" : "translate" === l7 && "no" === c4 ? c4 = false : "o" === l7[0] && "n" === l7[1] ? "ondoubleclick" === l7 ? i5 = "ondblclick" : "onchange" !== l7 || "input" !== e4 && "textarea" !== e4 || X2(t4.type) ? "onfocus" === l7 ? i5 = "onfocusin" : "onblur" === l7 ? i5 = "onfocusout" : J3.test(i5) && (i5 = l7) : l7 = i5 = "oninput" : o4 && G2.test(i5) ? i5 = i5.replace(K2, "-$&").toLowerCase() : null === c4 && (c4 = void 0), "oninput" === l7 && u5[i5 = l7] && (i5 = "oninputCapture"), u5[i5] = c4;
      }
    }
    "select" == e4 && u5.multiple && Array.isArray(u5.value) && (u5.value = H(t4.children).forEach(function(n5) {
      n5.props.selected = -1 != u5.value.indexOf(n5.props.value);
    })), "select" == e4 && null != u5.defaultValue && (u5.value = H(t4.children).forEach(function(n5) {
      n5.props.selected = u5.multiple ? -1 != u5.defaultValue.indexOf(n5.props.value) : u5.defaultValue == n5.props.value;
    })), t4.class && !t4.className ? (u5.class = t4.class, Object.defineProperty(u5, "className", ln)) : (t4.className && !t4.class || t4.class && t4.className) && (u5.class = u5.className = t4.className), n4.props = u5;
  }(n3), n3.$$typeof = q4, fn && fn(n3);
};
var an = l.__r;
l.__r = function(n3) {
  an && an(n3), cn = n3.__c;
};
var sn = l.diffed;
l.diffed = function(n3) {
  sn && sn(n3);
  var t4 = n3.props, e4 = n3.__e;
  null != e4 && "textarea" === n3.type && "value" in t4 && t4.value !== e4.value && (e4.value = null == t4.value ? "" : t4.value), cn = null;
};

// src/components/Tooltip.tsx
var BUBBLE_MARGIN = 6;
var BUBBLE_MAX_WIDTH = 320;
var VIEWPORT_PADDING = 8;
function Tooltip({ text, children, side = "top" }) {
  const [pos, setPos] = h2(null);
  const wrapRef = A2(null);
  const bubbleRef = A2(null);
  function computePos() {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wrapRect = wrap.getBoundingClientRect();
    const bubble = bubbleRef.current;
    const bubbleWidth = bubble?.offsetWidth ?? Math.min(BUBBLE_MAX_WIDTH, window.innerWidth - 2 * VIEWPORT_PADDING);
    const bubbleHeight = bubble?.offsetHeight ?? 120;
    const roomAbove = wrapRect.top - VIEWPORT_PADDING - BUBBLE_MARGIN;
    const roomBelow = window.innerHeight - wrapRect.bottom - VIEWPORT_PADDING - BUBBLE_MARGIN;
    const topFits = roomAbove >= bubbleHeight;
    const bottomFits = roomBelow >= bubbleHeight;
    let actualSide;
    if (side === "top") {
      actualSide = topFits || roomAbove >= roomBelow ? "top" : "bottom";
    } else {
      actualSide = bottomFits || roomBelow >= roomAbove ? "bottom" : "top";
    }
    const centerX = wrapRect.left + wrapRect.width / 2;
    let left = centerX - bubbleWidth / 2;
    left = Math.max(VIEWPORT_PADDING, Math.min(window.innerWidth - bubbleWidth - VIEWPORT_PADDING, left));
    let top = actualSide === "top" ? wrapRect.top - BUBBLE_MARGIN - bubbleHeight : wrapRect.bottom + BUBBLE_MARGIN;
    top = Math.max(VIEWPORT_PADDING, Math.min(window.innerHeight - bubbleHeight - VIEWPORT_PADDING, top));
    setPos({ top, left, side: actualSide });
  }
  function open() {
    computePos();
  }
  function close() {
    setPos(null);
  }
  y2(() => {
    if (pos) {
      const t4 = setTimeout(() => computePos(), 0);
      return () => clearTimeout(t4);
    }
    return void 0;
  }, [pos !== null]);
  y2(() => {
    if (!pos) return void 0;
    const onChange = () => close();
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
    };
  }, [pos !== null]);
  return /* @__PURE__ */ u4(
    "span",
    {
      ref: wrapRef,
      class: "tooltip-wrap",
      onMouseEnter: open,
      onMouseLeave: close,
      onFocusIn: open,
      onFocusOut: close,
      children: [
        children,
        pos ? $3(
          /* @__PURE__ */ u4(
            "div",
            {
              ref: bubbleRef,
              class: `tooltip-bubble tooltip-${pos.side}`,
              role: "tooltip",
              style: { top: pos.top + "px", left: pos.left + "px" },
              children: text.split("\n").map((line, i5) => /* @__PURE__ */ u4("span", { class: "tooltip-line", children: line }, i5))
            }
          ),
          document.body
        ) : null
      ]
    }
  );
}
function InfoIcon({ text }) {
  return /* @__PURE__ */ u4(Tooltip, { text, children: /* @__PURE__ */ u4("span", { class: "info-icon", tabindex: 0, "aria-label": "More info", children: "i" }) });
}

// src/components/Combobox.tsx
function Combobox({
  value,
  options,
  placeholder,
  disabled,
  freeform = true,
  onChange
}) {
  const [open, setOpen] = h2(false);
  const [text, setText] = h2(value ?? "");
  const [filtering, setFiltering] = h2(false);
  const [highlight, setHighlight] = h2(-1);
  const rootRef = A2(null);
  const inputRef = A2(null);
  const valueRef = A2(value);
  valueRef.current = value;
  y2(() => {
    const v5 = value ?? "";
    if (v5 !== text) {
      setText(v5);
      setFiltering(false);
    }
  }, [value]);
  y2(() => {
    if (!open) return void 0;
    const onDoc = (e4) => {
      if (!rootRef.current?.contains(e4.target)) {
        if (freeform) commitText(text);
        setOpen(false);
        setFiltering(false);
        if (!freeform) setText(valueRef.current ?? "");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, freeform, text]);
  const filterText = text.trim().toLowerCase();
  const matches = filtering && filterText ? options.filter(
    (o4) => o4.value.toLowerCase().includes(filterText) || o4.label.toLowerCase().includes(filterText)
  ) : options;
  function finishCommit(next) {
    setText(next);
    setOpen(false);
    setFiltering(false);
    setHighlight(-1);
  }
  function commitOption(next) {
    onChange(next || null);
    finishCommit(next);
  }
  function commitText(next) {
    if (!freeform) return;
    const trimmed = next.trim();
    onChange(trimmed || null);
    finishCommit(trimmed);
  }
  function onKeyDown(e4) {
    if (disabled) return;
    if (e4.key === "ArrowDown") {
      e4.preventDefault();
      setOpen(true);
      setHighlight((h5) => Math.min(h5 + 1, matches.length - 1));
    } else if (e4.key === "ArrowUp") {
      e4.preventDefault();
      setHighlight((h5) => Math.max(h5 - 1, 0));
    } else if (e4.key === "Enter") {
      if (open && highlight >= 0 && matches[highlight]) {
        e4.preventDefault();
        commitOption(matches[highlight].value);
      } else if (freeform) {
        commitText(text);
      }
    } else if (e4.key === "Escape") {
      setOpen(false);
      setFiltering(false);
      setHighlight(-1);
    }
  }
  return /* @__PURE__ */ u4("div", { ref: rootRef, class: "combobox", "data-open": open, children: [
    /* @__PURE__ */ u4(
      "input",
      {
        ref: inputRef,
        type: "text",
        class: "combobox-input",
        value: text,
        placeholder,
        disabled,
        autocomplete: "off",
        spellcheck: false,
        onFocus: () => setOpen(true),
        onInput: (e4) => {
          const v5 = e4.currentTarget.value;
          setText(v5);
          setOpen(true);
          setFiltering(true);
          setHighlight(-1);
        },
        onKeyDown
      }
    ),
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "combobox-caret",
        tabIndex: -1,
        "aria-label": "Show options",
        disabled,
        onMouseDown: (e4) => {
          e4.preventDefault();
          setOpen((o4) => !o4);
          setFiltering(false);
        },
        children: "\u25BE"
      }
    ),
    open && matches.length > 0 ? /* @__PURE__ */ u4("ul", { class: "combobox-list", role: "listbox", children: matches.map((o4, i5) => /* @__PURE__ */ u4(
      "li",
      {
        role: "option",
        "aria-selected": o4.value === value,
        class: "combobox-option" + (i5 === highlight ? " highlight" : "") + (o4.value === value ? " selected" : ""),
        onMouseEnter: () => setHighlight(i5),
        onMouseDown: (e4) => {
          e4.preventDefault();
          e4.stopPropagation();
          commitOption(o4.value);
        },
        children: [
          /* @__PURE__ */ u4("span", { class: "combobox-option-main", children: [
            /* @__PURE__ */ u4("span", { class: "combobox-option-label", children: o4.label }),
            o4.detail ? /* @__PURE__ */ u4("span", { class: "combobox-option-detail", children: o4.detail }) : null
          ] }),
          o4.tooltip ? /* @__PURE__ */ u4(
            "span",
            {
              class: "combobox-option-info",
              onMouseDown: (e4) => e4.preventDefault(),
              children: /* @__PURE__ */ u4(InfoIcon, { text: o4.tooltip })
            }
          ) : null
        ]
      },
      o4.value
    )) }) : null
  ] });
}

// src/components/ModelPickerDialog.tsx
var COST_TIERS = [
  { id: "free", label: "Free", test: (m6) => (m6.inputCostPerMTok ?? 0) === 0 && (m6.outputCostPerMTok ?? 0) === 0 },
  { id: "low", label: "< $1/Mtok", test: (m6) => (m6.outputCostPerMTok ?? Infinity) > 0 && (m6.outputCostPerMTok ?? Infinity) < 1 },
  { id: "mid", label: "$1 \u2013 $5", test: (m6) => (m6.outputCostPerMTok ?? 0) >= 1 && (m6.outputCostPerMTok ?? Infinity) <= 5 },
  { id: "high", label: "$5 \u2013 $20", test: (m6) => (m6.outputCostPerMTok ?? 0) > 5 && (m6.outputCostPerMTok ?? Infinity) <= 20 },
  { id: "premium", label: "> $20", test: (m6) => (m6.outputCostPerMTok ?? 0) > 20 }
];
var CTX_TIERS = [
  { id: "32k", label: "\u2265 32k", min: 32e3 },
  { id: "128k", label: "\u2265 128k", min: 128e3 },
  { id: "200k", label: "\u2265 200k", min: 2e5 },
  { id: "1m", label: "\u2265 1M", min: 1e6 }
];
var ALL_INPUT_MODALITIES = ["text", "image", "audio", "video"];
var ALL_OUTPUT_MODALITIES = ["text", "image"];
function formatDetailLine(m6) {
  const parts = [];
  if (m6.contextWindow) {
    const k4 = m6.contextWindow >= 1e6 ? `${(m6.contextWindow / 1e6).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(m6.contextWindow / 1024)}k`;
    parts.push(`${k4} ctx`);
  }
  if (m6.inputCostPerMTok != null && m6.outputCostPerMTok != null) {
    if (m6.inputCostPerMTok === 0 && m6.outputCostPerMTok === 0) {
      parts.push("free");
    } else {
      parts.push(`$${m6.inputCostPerMTok}/$${m6.outputCostPerMTok} per Mtok`);
    }
  }
  const modIn = m6.modalitiesIn?.filter((x6) => x6 !== "text");
  if (modIn?.length) parts.push(modIn.join("+") + " in");
  return parts.join(" \xB7 ");
}
var catalogCache = /* @__PURE__ */ new Map();
var CACHE_TTL_MS = 5 * 60 * 1e3;
function fetchModels(url) {
  const now = Date.now();
  const cached = catalogCache.get(url);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.promise;
  }
  const promise = (async () => {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      const data = await res.json();
      return { ok: res.ok, data };
    } catch {
      catalogCache.delete(url);
      return { ok: false, data: {} };
    }
  })();
  catalogCache.set(url, { fetchedAt: now, promise });
  return promise;
}
function ModelPickerDialog({
  value,
  provider,
  placeholder,
  disabled,
  apiBasePath,
  inputModality,
  outputModality,
  onChange
}) {
  const [open, setOpen] = h2(false);
  const [models, setModels] = h2([]);
  const [source, setSource] = h2("unavailable");
  const [loading, setLoading] = h2(false);
  const [search, setSearch] = h2("");
  const [selectedInputMods, setSelectedInputMods] = h2(/* @__PURE__ */ new Set());
  const [selectedOutputMods, setSelectedOutputMods] = h2(/* @__PURE__ */ new Set());
  const [selectedCostTiers, setSelectedCostTiers] = h2(/* @__PURE__ */ new Set());
  const [selectedCtxTier, setSelectedCtxTier] = h2(null);
  const [freeformValue, setFreeformValue] = h2("");
  const searchRef = A2(null);
  const catalogUrl = T2(() => {
    if (!provider) return null;
    const params = new URLSearchParams({ provider });
    if (inputModality) params.set("inputModality", inputModality);
    if (outputModality) params.set("outputModality", outputModality);
    return `${apiBasePath}/models?${params.toString()}`;
  }, [provider, apiBasePath, inputModality, outputModality]);
  y2(() => {
    if (!catalogUrl) {
      setModels([]);
      return;
    }
    let cancelled = false;
    fetchModels(catalogUrl).then((r4) => {
      if (cancelled) return;
      if (r4.ok) {
        setModels(r4.data.models ?? []);
        setSource(r4.data.source ?? "unavailable");
      } else {
        setModels([]);
        setSource("unavailable");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [catalogUrl]);
  y2(() => {
    if (!open || !catalogUrl) return;
    let cancelled = false;
    setLoading(true);
    fetchModels(catalogUrl).then((r4) => {
      if (cancelled) return;
      if (r4.ok) {
        setModels(r4.data.models ?? []);
        setSource(r4.data.source ?? "unavailable");
      } else {
        setModels([]);
        setSource("unavailable");
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, catalogUrl]);
  y2(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);
  const filtered = T2(() => {
    let result = models;
    if (search.trim()) {
      const q5 = search.trim().toLowerCase();
      result = result.filter(
        (m6) => m6.id.toLowerCase().includes(q5) || m6.label.toLowerCase().includes(q5)
      );
    }
    if (selectedInputMods.size > 0) {
      result = result.filter(
        (m6) => [...selectedInputMods].every((mod) => m6.modalitiesIn?.includes(mod))
      );
    }
    if (selectedOutputMods.size > 0) {
      result = result.filter(
        (m6) => [...selectedOutputMods].every((mod) => m6.modalitiesOut?.includes(mod))
      );
    }
    if (selectedCostTiers.size > 0) {
      const activeTiers = COST_TIERS.filter((t4) => selectedCostTiers.has(t4.id));
      result = result.filter((m6) => activeTiers.some((t4) => t4.test(m6)));
    }
    if (selectedCtxTier) {
      const tier = CTX_TIERS.find((t4) => t4.id === selectedCtxTier);
      if (tier) {
        result = result.filter((m6) => (m6.contextWindow ?? 0) >= tier.min);
      }
    }
    return result;
  }, [models, search, selectedInputMods, selectedOutputMods, selectedCostTiers, selectedCtxTier]);
  const handleSelect = q2((id) => {
    onChange(id);
    setOpen(false);
  }, [onChange]);
  const handleFreeformSubmit = q2(() => {
    const trimmed = freeformValue.trim();
    if (trimmed) {
      onChange(trimmed);
      setOpen(false);
      setFreeformValue("");
    }
  }, [freeformValue, onChange]);
  const handleClear = q2(() => {
    onChange(null);
    setOpen(false);
  }, [onChange]);
  const toggleSet = (set, val) => {
    const next = new Set(set);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    return next;
  };
  const matched = models.find((m6) => m6.id === value);
  const triggerName = matched?.label ?? value;
  const triggerDetail = matched ? formatDetailLine(matched) : null;
  const handleKeyDown = q2((e4) => {
    if (e4.key === "Escape") setOpen(false);
  }, []);
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "mpd-trigger",
        disabled: disabled || !provider,
        onClick: () => {
          setOpen(true);
          setSearch("");
        },
        children: [
          /* @__PURE__ */ u4("span", { class: "mpd-trigger-label", children: value ? /* @__PURE__ */ u4(k, { children: [
            /* @__PURE__ */ u4("span", { class: "mpd-trigger-name", children: triggerName }),
            triggerDetail && /* @__PURE__ */ u4("span", { class: "mpd-trigger-detail", children: triggerDetail })
          ] }) : /* @__PURE__ */ u4("span", { class: "mpd-trigger-placeholder", children: placeholder || "pick or type a model id" }) }),
          /* @__PURE__ */ u4("span", { class: "mpd-trigger-icon", children: "\u25BE" })
        ]
      }
    ),
    open && /* @__PURE__ */ u4(
      "div",
      {
        class: "mpd-backdrop",
        onMouseDown: (e4) => {
          if (e4.target === e4.currentTarget) setOpen(false);
        },
        onKeyDown: handleKeyDown,
        children: /* @__PURE__ */ u4("div", { class: "mpd-dialog", role: "dialog", "aria-label": "Pick a model", children: [
          /* @__PURE__ */ u4("div", { class: "mpd-head", children: [
            /* @__PURE__ */ u4("span", { class: "mpd-title", children: "Pick a model" }),
            value && /* @__PURE__ */ u4("button", { type: "button", class: "mpd-close", title: "Clear selection", onClick: handleClear, children: "\u2715 Clear" }),
            /* @__PURE__ */ u4("button", { type: "button", class: "mpd-close", title: "Close", onClick: () => setOpen(false), children: "\u2715" })
          ] }),
          /* @__PURE__ */ u4("div", { class: "mpd-content", children: [
            /* @__PURE__ */ u4("div", { class: "mpd-sidebar", children: [
              /* @__PURE__ */ u4("div", { class: "mpd-filter-group", children: [
                /* @__PURE__ */ u4("div", { class: "mpd-filter-group-title", children: "Input" }),
                ALL_INPUT_MODALITIES.map((mod) => /* @__PURE__ */ u4("div", { class: "mpd-filter-option", children: [
                  /* @__PURE__ */ u4(
                    "input",
                    {
                      type: "checkbox",
                      id: `mpd-in-${mod}`,
                      checked: selectedInputMods.has(mod),
                      onChange: () => setSelectedInputMods(toggleSet(selectedInputMods, mod))
                    }
                  ),
                  /* @__PURE__ */ u4("label", { for: `mpd-in-${mod}`, children: mod })
                ] }, mod))
              ] }),
              /* @__PURE__ */ u4("div", { class: "mpd-filter-group", children: [
                /* @__PURE__ */ u4("div", { class: "mpd-filter-group-title", children: "Output" }),
                ALL_OUTPUT_MODALITIES.map((mod) => /* @__PURE__ */ u4("div", { class: "mpd-filter-option", children: [
                  /* @__PURE__ */ u4(
                    "input",
                    {
                      type: "checkbox",
                      id: `mpd-out-${mod}`,
                      checked: selectedOutputMods.has(mod),
                      onChange: () => setSelectedOutputMods(toggleSet(selectedOutputMods, mod))
                    }
                  ),
                  /* @__PURE__ */ u4("label", { for: `mpd-out-${mod}`, children: mod })
                ] }, mod))
              ] }),
              /* @__PURE__ */ u4("div", { class: "mpd-filter-group", children: [
                /* @__PURE__ */ u4("div", { class: "mpd-filter-group-title", children: "Cost (output)" }),
                COST_TIERS.map((tier) => /* @__PURE__ */ u4("div", { class: "mpd-filter-option", children: [
                  /* @__PURE__ */ u4(
                    "input",
                    {
                      type: "checkbox",
                      id: `mpd-cost-${tier.id}`,
                      checked: selectedCostTiers.has(tier.id),
                      onChange: () => setSelectedCostTiers(toggleSet(selectedCostTiers, tier.id))
                    }
                  ),
                  /* @__PURE__ */ u4("label", { for: `mpd-cost-${tier.id}`, children: tier.label })
                ] }, tier.id))
              ] }),
              /* @__PURE__ */ u4("div", { class: "mpd-filter-group", children: [
                /* @__PURE__ */ u4("div", { class: "mpd-filter-group-title", children: "Context window" }),
                CTX_TIERS.map((tier) => /* @__PURE__ */ u4("div", { class: "mpd-filter-option", children: [
                  /* @__PURE__ */ u4(
                    "input",
                    {
                      type: "checkbox",
                      id: `mpd-ctx-${tier.id}`,
                      checked: selectedCtxTier === tier.id,
                      onChange: () => setSelectedCtxTier(selectedCtxTier === tier.id ? null : tier.id)
                    }
                  ),
                  /* @__PURE__ */ u4("label", { for: `mpd-ctx-${tier.id}`, children: tier.label })
                ] }, tier.id))
              ] })
            ] }),
            /* @__PURE__ */ u4("div", { class: "mpd-main", children: [
              /* @__PURE__ */ u4("div", { class: "mpd-search", children: /* @__PURE__ */ u4(
                "input",
                {
                  ref: searchRef,
                  type: "text",
                  placeholder: "Search models\u2026",
                  value: search,
                  onInput: (e4) => setSearch(e4.target.value)
                }
              ) }),
              /* @__PURE__ */ u4("div", { class: "mpd-list", children: [
                loading && /* @__PURE__ */ u4("div", { class: "mpd-empty", children: "Loading\u2026" }),
                !loading && source === "unavailable" && /* @__PURE__ */ u4("div", { class: "mpd-empty", children: "Model catalog unavailable." }),
                !loading && source !== "unavailable" && filtered.length === 0 && /* @__PURE__ */ u4("div", { class: "mpd-empty", children: "No models match filters." }),
                !loading && filtered.map((m6) => /* @__PURE__ */ u4(
                  "button",
                  {
                    type: "button",
                    class: `mpd-item${m6.id === value ? " selected" : ""}`,
                    onClick: () => handleSelect(m6.id),
                    children: [
                      /* @__PURE__ */ u4("div", { class: "mpd-item-name", children: m6.label }),
                      /* @__PURE__ */ u4("div", { class: "mpd-item-detail", children: formatDetailLine(m6) })
                    ]
                  },
                  m6.id
                ))
              ] }),
              /* @__PURE__ */ u4("div", { class: "mpd-freeform", children: [
                /* @__PURE__ */ u4(
                  "input",
                  {
                    type: "text",
                    placeholder: "Or type a custom model ID\u2026",
                    value: freeformValue,
                    onInput: (e4) => setFreeformValue(e4.target.value),
                    onKeyDown: (e4) => {
                      if (e4.key === "Enter") handleFreeformSubmit();
                    }
                  }
                ),
                /* @__PURE__ */ u4("button", { type: "button", disabled: !freeformValue.trim(), onClick: handleFreeformSubmit, children: "Use" })
              ] })
            ] })
          ] })
        ] })
      }
    )
  ] });
}

// src/components/GroupAdmin.tsx
var SETTINGS_SECTIONS = /* @__PURE__ */ new Set(["models", "settings", "packages", "mcp", "skills"]);
var TAB_ITEMS = [
  { id: "settings", label: "Settings", sublabel: "Image, scope, public site" },
  { id: "models", label: "Models", sublabel: "Provider, model, voice" },
  { id: "packages", label: "Packages", sublabel: "apt / npm / pip in the image" },
  { id: "mcp", label: "MCP servers", sublabel: "External tools wired to the agent" },
  { id: "skills", label: "Skills", sublabel: "Container skills mounted at runtime" },
  { id: "members", label: "Members", sublabel: "Who can use this group" },
  { id: "roles", label: "Admins", sublabel: "Admins for this group" },
  { id: "destinations", label: "Destinations", sublabel: "Where this group can send messages" }
];
var PROVIDER_INFO = {
  claude: "Claude \u2014 Anthropic models via the official SDK. Uses your OneCLI-injected Anthropic API key.",
  opencode: "OpenCode \u2014 multi-provider gateway (OpenRouter, DeepSeek, OpenCode Zen, Anthropic, etc.) selected by host OPENCODE_PROVIDER. Wire prefix is handled automatically."
};
function formatAge(iso) {
  if (!iso) return null;
  const t4 = Date.parse(iso);
  if (Number.isNaN(t4)) return null;
  const diffMs = Date.now() - t4;
  const day = 24 * 3600 * 1e3;
  const hour = 3600 * 1e3;
  if (diffMs < hour) return "just now";
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  const days = Math.floor(diffMs / day);
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
function formatSize(bytes) {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function apiPath(gid, sub) {
  return `/ui/chat/api/groups/${encodeURIComponent(gid)}/admin${sub}`;
}
async function call(url, method = "GET", body) {
  const r4 = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : void 0
  });
  let data = {};
  try {
    data = await r4.json();
  } catch {
  }
  return { ok: r4.ok, status: r4.status, data };
}
function errMsg2(d5, fallback) {
  const e4 = d5?.error;
  return typeof e4 === "string" && e4 ? e4 : fallback;
}
function GroupAdmin() {
  const open = groupAdminOpen.value;
  const gid = groupId.value;
  const mobile = isMobile.value;
  const [tab, setTab] = h2(() => isMobile.value ? null : "settings");
  const actionsRef = A2(null);
  const [, forceRender] = h2(0);
  const [closeConfirmOpen, setCloseConfirmOpen] = h2(false);
  y2(() => {
    setTab(isMobile.value ? null : "settings");
    setCloseConfirmOpen(false);
  }, [open, gid]);
  useBackButtonCloses(open, () => {
    groupAdminOpen.value = false;
  });
  if (!open || !gid) return null;
  const group = groups.value.find((g8) => g8.id === gid);
  const title = group ? `Admin \xB7 ${group.name}` : "Admin";
  function hardClose() {
    groupAdminOpen.value = false;
  }
  function attemptClose() {
    if (actionsRef.current?.canSave) {
      setCloseConfirmOpen(true);
    } else {
      hardClose();
    }
  }
  function onBackdrop(e4) {
    if (e4.target.classList.contains("settings-backdrop")) attemptClose();
  }
  function onKey(e4) {
    if (e4.key === "Escape") attemptClose();
  }
  y2(() => {
    if (!open) return void 0;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const ha = actionsRef.current;
  const setActions = (a4) => {
    actionsRef.current = a4;
    forceRender((n3) => n3 + 1);
  };
  return /* @__PURE__ */ u4("div", { class: "settings-backdrop", onClick: onBackdrop, children: /* @__PURE__ */ u4("div", { class: "settings-modal", role: "dialog", "aria-label": title, children: [
    /* @__PURE__ */ u4("header", { class: "settings-head", children: [
      /* @__PURE__ */ u4("span", { class: "title", children: title }),
      /* @__PURE__ */ u4("div", { class: "settings-head-actions", children: [
        tab !== null && SETTINGS_SECTIONS.has(tab) && ha ? /* @__PURE__ */ u4(k, { children: /* @__PURE__ */ u4(Tooltip, { text: ha.canSave ? "Save changes" : "Nothing to save", children: /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Save", onClick: ha.apply, disabled: ha.busy || !ha.canSave, children: "\u2713" }) }) }) : null,
        /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: attemptClose, children: "\u2715" })
      ] })
    ] }),
    !mobile ? /* @__PURE__ */ u4(
      TabBar,
      {
        ariaLabel: "Group settings sections",
        mobileSheetTitle: "Settings sections",
        activeId: tab,
        items: TAB_ITEMS,
        onSelect: (id) => setTab(id),
        className: "group-admin-tab-bar"
      }
    ) : null,
    /* @__PURE__ */ u4("div", { class: "settings-body", children: mobile && tab === null ? /* @__PURE__ */ u4(MobileSectionList, { items: TAB_ITEMS, onSelect: (id) => setTab(id) }) : /* @__PURE__ */ u4(k, { children: [
      mobile && tab !== null ? /* @__PURE__ */ u4(
        "button",
        {
          type: "button",
          class: "group-admin-back",
          onClick: () => setTab(null),
          "aria-label": "Back to sections",
          children: [
            /* @__PURE__ */ u4("span", { "aria-hidden": "true", children: "\u2039" }),
            " Sections"
          ]
        }
      ) : null,
      tab !== null && SETTINGS_SECTIONS.has(tab) ? /* @__PURE__ */ u4(SettingsTab, { gid, section: tab, onClose: hardClose, onActions: setActions }) : null,
      tab === "members" ? /* @__PURE__ */ u4(MembersTab, { gid }) : null,
      tab === "roles" ? /* @__PURE__ */ u4(RolesTab, { gid }) : null,
      tab === "destinations" ? /* @__PURE__ */ u4(DestinationsTab, { gid }) : null
    ] }) }),
    closeConfirmOpen ? /* @__PURE__ */ u4(
      "div",
      {
        class: "settings-backdrop",
        onClick: (e4) => {
          if (e4.target.classList.contains("settings-backdrop")) setCloseConfirmOpen(false);
        },
        children: /* @__PURE__ */ u4("div", { class: "settings-modal ga-confirm-modal", role: "dialog", "aria-label": "Discard changes?", style: "max-width:420px", children: [
          /* @__PURE__ */ u4("header", { class: "settings-head", children: [
            /* @__PURE__ */ u4("span", { class: "title", children: "Discard unsaved changes?" }),
            /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: () => setCloseConfirmOpen(false), children: "\u2715" })
          ] }),
          /* @__PURE__ */ u4("div", { class: "settings-body", children: /* @__PURE__ */ u4("p", { class: "group-admin-help", children: "You have unsaved changes. Closing now discards them." }) }),
          /* @__PURE__ */ u4("footer", { class: "settings-foot ga-confirm-foot", children: [
            /* @__PURE__ */ u4("button", { type: "button", onClick: () => setCloseConfirmOpen(false), children: "Keep editing" }),
            /* @__PURE__ */ u4(
              "button",
              {
                type: "button",
                class: "danger",
                "data-testid": "discard-and-close-btn",
                onClick: () => {
                  setCloseConfirmOpen(false);
                  hardClose();
                },
                children: "Discard & close"
              }
            )
          ] })
        ] })
      }
    ) : null
  ] }) });
}
function MobileSectionList({ items, onSelect }) {
  return /* @__PURE__ */ u4("div", { class: "group-admin-section-list", role: "list", children: items.map((it) => /* @__PURE__ */ u4(
    "button",
    {
      type: "button",
      role: "listitem",
      class: "group-admin-section-row",
      onClick: () => onSelect(it.id),
      children: [
        /* @__PURE__ */ u4("span", { class: "group-admin-section-name", children: it.label }),
        it.sublabel ? /* @__PURE__ */ u4("span", { class: "group-admin-section-sub", children: it.sublabel }) : null,
        /* @__PURE__ */ u4("span", { class: "group-admin-section-caret", "aria-hidden": "true", children: "\u203A" })
      ]
    },
    it.id
  )) });
}
function SettingsTab({ gid, section, onClose, onActions }) {
  const [data, setData] = h2(null);
  const [draft, setDraft] = h2(null);
  const [draftName, setDraftName] = h2("");
  const [siteEnabled, setSiteEnabled] = h2(false);
  const [siteSlug, setSiteSlug] = h2("");
  const [draftModelParams, setDraftModelParams] = h2({});
  const [draftPackages, setDraftPackages] = h2({ apt: [], npm: [], pip: [] });
  const [draftMcpServers, setDraftMcpServers] = h2({});
  const [draftSkills, setDraftSkills] = h2([]);
  const [busy, setBusy] = h2(false);
  const [images, setImages] = h2(null);
  async function refresh() {
    setBusy(true);
    try {
      const r4 = await call(apiPath(gid, "/settings"));
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      setData(r4.data);
      setDraft({ ...r4.data.config });
      setDraftName(r4.data.name);
      setSiteEnabled(r4.data.site.enabled);
      setSiteSlug(r4.data.site.slug ?? "");
      setDraftModelParams(r4.data.modelParams);
      setDraftPackages({
        apt: [...r4.data.packages?.apt ?? []],
        npm: [...r4.data.packages?.npm ?? []],
        pip: [...r4.data.packages?.pip ?? []]
      });
      setDraftMcpServers({ ...r4.data.mcpServers ?? {} });
      setDraftSkills(r4.data.skills === "all" ? "all" : [...r4.data.skills ?? []]);
    } finally {
      setBusy(false);
    }
  }
  y2(() => {
    refresh();
  }, [gid]);
  y2(() => {
    let cancelled = false;
    (async () => {
      const r4 = await call(apiPath(gid, "/images"));
      if (!cancelled) setImages(r4.ok ? r4.data : { images: [] });
    })();
    return () => {
      cancelled = true;
    };
  }, [gid]);
  const provider = draft?.provider ?? null;
  if (!data || !draft) return /* @__PURE__ */ u4("p", { class: "muted", children: "Loading\u2026" });
  function update(k4, v5) {
    setDraft((d5) => d5 ? { ...d5, [k4]: v5 } : d5);
  }
  async function runRestart(rebuild) {
    const r4 = await call(apiPath(gid, "/restart"), "POST", { rebuild });
    if (!r4.ok) {
      showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
      return { ok: false };
    }
    return { ok: true, restarted: r4.data.restarted };
  }
  const RESTART_REQUIRING_FIELDS = /* @__PURE__ */ new Set([
    "provider",
    "model",
    "small_model",
    "effort",
    "image_tag",
    "assistant_name",
    "max_messages_per_prompt",
    "model_params",
    "mcp_servers",
    "skills",
    "packages_apt",
    "packages_npm",
    "packages_pip"
  ]);
  function changedFields() {
    const out = /* @__PURE__ */ new Set();
    if (!data || !draft) return out;
    if (draftName.trim() !== data.name) out.add("name");
    for (const k4 of Object.keys(draft)) {
      if (draft[k4] !== data.config[k4]) out.add(k4);
    }
    if (data.site.available) {
      if (siteEnabled !== data.site.enabled) out.add("site_enabled");
      if (data.actorIsElevated && siteSlug.trim() !== (data.site.slug ?? "")) out.add("site_slug");
    }
    if (JSON.stringify(draftModelParams) !== JSON.stringify(data.modelParams ?? {})) out.add("model_params");
    const dataPkg = data.packages ?? { apt: [], npm: [], pip: [] };
    if (JSON.stringify(draftPackages.apt) !== JSON.stringify(dataPkg.apt)) out.add("packages_apt");
    if (JSON.stringify(draftPackages.npm) !== JSON.stringify(dataPkg.npm)) out.add("packages_npm");
    if (JSON.stringify(draftPackages.pip) !== JSON.stringify(dataPkg.pip)) out.add("packages_pip");
    if (JSON.stringify(draftMcpServers) !== JSON.stringify(data.mcpServers ?? {})) out.add("mcp_servers");
    if (JSON.stringify(draftSkills) !== JSON.stringify(data.skills ?? [])) out.add("skills");
    return out;
  }
  const pending2 = changedFields();
  const changed = pending2.size > 0;
  const needsRestart = [...pending2].some((f5) => RESTART_REQUIRING_FIELDS.has(f5));
  const imageRebuildNeeded = pending2.has("image_tag") && draft.image_tag != null && !!images && !images.images.some((i5) => i5.value === draft.image_tag);
  const packagesChanged = pending2.has("packages_apt") || pending2.has("packages_npm") || pending2.has("packages_pip");
  const needsRebuild = imageRebuildNeeded || packagesChanged;
  const [confirmOpen, setConfirmOpen] = h2(false);
  const [restartChecked, setRestartChecked] = h2(false);
  const [rebuildChecked, setRebuildChecked] = h2(false);
  const [archiveOpen, setArchiveOpen] = h2(false);
  const [archiveConfirm, setArchiveConfirm] = h2("");
  const [archiveBusy, setArchiveBusy] = h2(false);
  const effectiveRestart = restartChecked || rebuildChecked;
  const effectiveRebuild = rebuildChecked;
  const canSave = changed;
  y2(() => {
    onActions({ refresh, apply: apply2, busy, canSave });
    return () => onActions(null);
  }, [busy, canSave, needsRestart, needsRebuild]);
  function apply2() {
    if (!changed) return;
    setRestartChecked(needsRestart || needsRebuild);
    setRebuildChecked(needsRebuild);
    setConfirmOpen(true);
  }
  async function doApply() {
    if (!draft) return;
    setBusy(true);
    try {
      const JSON_FIELDS = /* @__PURE__ */ new Set([
        "model_params",
        "mcp_servers",
        "skills",
        "packages_apt",
        "packages_npm",
        "packages_pip"
      ]);
      const settingsChanged = [...pending2].some((f5) => !JSON_FIELDS.has(f5));
      if (settingsChanged) {
        const body = { ...draft };
        if (data && draftName.trim() !== data.name) body.name = draftName.trim();
        if (pending2.has("site_enabled")) body.site_enabled = siteEnabled;
        if (pending2.has("site_slug")) body.site_slug = siteSlug.trim() || null;
        const r4 = await call(apiPath(gid, "/settings"), "PATCH", body);
        if (!r4.ok) {
          showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
          return;
        }
      }
      if (pending2.has("model_params")) {
        const r4 = await call(
          apiPath(gid, "/model-params"),
          "PATCH",
          { params: draftModelParams }
        );
        if (!r4.ok) {
          showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
          return;
        }
      }
      if (pending2.has("packages_apt") || pending2.has("packages_npm") || pending2.has("packages_pip")) {
        const body = {};
        if (pending2.has("packages_apt")) body.apt = draftPackages.apt;
        if (pending2.has("packages_npm")) body.npm = draftPackages.npm;
        if (pending2.has("packages_pip")) body.pip = draftPackages.pip;
        const r4 = await call(apiPath(gid, "/packages"), "PATCH", body);
        if (!r4.ok) {
          showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
          return;
        }
      }
      if (pending2.has("mcp_servers")) {
        const r4 = await call(apiPath(gid, "/mcp-servers"), "PATCH", { servers: draftMcpServers });
        if (!r4.ok) {
          showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
          return;
        }
      }
      if (pending2.has("skills")) {
        const r4 = await call(apiPath(gid, "/skills"), "PATCH", { skills: draftSkills });
        if (!r4.ok) {
          showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
          return;
        }
      }
      const fresh = await call(apiPath(gid, "/settings"));
      if (fresh.ok) {
        setData(fresh.data);
        setDraft({ ...fresh.data.config });
        setDraftName(fresh.data.name);
        setSiteEnabled(fresh.data.site.enabled);
        setSiteSlug(fresh.data.site.slug ?? "");
        setDraftModelParams(fresh.data.modelParams);
        setDraftPackages({
          apt: [...fresh.data.packages?.apt ?? []],
          npm: [...fresh.data.packages?.npm ?? []],
          pip: [...fresh.data.packages?.pip ?? []]
        });
        setDraftMcpServers({ ...fresh.data.mcpServers ?? {} });
        setDraftSkills(fresh.data.skills === "all" ? "all" : [...fresh.data.skills ?? []]);
        groups.value = groups.value.map((g8) => g8.id === gid ? { ...g8, name: fresh.data.name } : g8);
      }
      if (effectiveRebuild || effectiveRestart) {
        const r4 = await runRestart(effectiveRebuild);
        if (!r4.ok) return;
        const msg = effectiveRebuild ? `Rebuilt image and restarted ${r4.restarted} session${r4.restarted === 1 ? "" : "s"}.` : `Restarted ${r4.restarted} session${r4.restarted === 1 ? "" : "s"}.`;
        showToast(msg);
      } else {
        showToast("Saved.");
      }
      setConfirmOpen(false);
      onClose();
    } finally {
      setBusy(false);
    }
  }
  async function doArchive() {
    if (!data || archiveBusy) return;
    setArchiveBusy(true);
    try {
      const r4 = await call(
        apiPath(gid, "/archive"),
        "POST",
        { confirm_folder: archiveConfirm.trim() }
      );
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      const archivedId = gid;
      const remaining = groups.value.filter((g8) => g8.id !== archivedId);
      groups.value = remaining;
      setArchiveOpen(false);
      onClose();
      showToast(`Archived. Restore on the host with: ncl groups restore --folder ${r4.data.folder}`);
      if (groupId.value === archivedId && remaining[0]) {
        void selectGroup(remaining[0].id);
      }
    } finally {
      setArchiveBusy(false);
    }
  }
  const imageOptions = (images?.images ?? []).map((i5) => {
    const age = formatAge(i5.createdAt);
    const size = formatSize(i5.size);
    const detailParts = [age, size, i5.isDefault ? "default" : null].filter(Boolean);
    return {
      value: i5.value,
      label: i5.label,
      detail: detailParts.length ? detailParts.join(" \xB7 ") : void 0,
      tooltip: [
        i5.value,
        i5.createdAt ? `Created: ${new Date(i5.createdAt).toLocaleString()}` : null,
        size ? `Size: ${size}` : null,
        i5.isDefault ? "Install default image (used when image_tag is unset)." : null
      ].filter(Boolean).join("\n")
    };
  });
  const selectedImg = images?.images.find((i5) => i5.value === draft.image_tag) ?? null;
  const selectedImgAge = formatAge(selectedImg?.createdAt ?? null);
  const selectedImgSize = formatSize(selectedImg?.size ?? null);
  return /* @__PURE__ */ u4("section", { children: [
    /* @__PURE__ */ u4("div", { class: "group-admin-toolbar", children: /* @__PURE__ */ u4("p", { class: "muted ga-folder-line", children: [
      "Folder ",
      /* @__PURE__ */ u4("code", { children: data.folder }),
      " ",
      /* @__PURE__ */ u4("code", { class: "ga-folder-id", children: data.id }),
      data.updatedAt ? ` \xB7 last updated ${new Date(data.updatedAt).toLocaleString()}` : "",
      data.runningSessionCount > 0 ? ` \xB7 ${data.runningSessionCount} running session${data.runningSessionCount === 1 ? "" : "s"}` : " \xB7 no running sessions"
    ] }) }),
    section === "models" ? /* @__PURE__ */ u4(k, { children: [
      /* @__PURE__ */ u4(
        Field,
        {
          label: "Provider",
          info: draft.provider ? PROVIDER_INFO[draft.provider] ?? `Provider "${draft.provider}".` : void 0,
          children: [
            /* @__PURE__ */ u4(
              Combobox,
              {
                value: draft.provider,
                options: (() => {
                  const selectable = data.validProviders.slice();
                  if (draft.provider && !selectable.includes(draft.provider)) {
                    selectable.push(draft.provider);
                  }
                  return selectable.map((p5) => ({
                    value: p5,
                    label: p5,
                    tooltip: PROVIDER_INFO[p5]
                  }));
                })(),
                placeholder: data.defaults.provider ? `default: ${data.defaults.provider}` : "pick a provider",
                disabled: busy,
                freeform: false,
                onChange: (v5) => update("provider", v5)
              }
            ),
            data.providesAgentSurfaces ? /* @__PURE__ */ u4("p", { class: "group-admin-help", children: "This provider composes its own instructions and discovers skills its own way, so the Skills selection and Assistant name don't apply while it's active." }) : null
          ]
        }
      ),
      /* @__PURE__ */ u4(Field, { label: "Model", children: /* @__PURE__ */ u4(
        ModelPickerDialog,
        {
          value: draft.model,
          provider: provider ?? data.defaults.provider,
          placeholder: data.defaults.model ? `default: ${data.defaults.model}` : "pick or type a model id",
          disabled: busy,
          apiBasePath: apiPath(gid, ""),
          outputModality: "text",
          onChange: (v5) => update("model", v5)
        }
      ) }),
      /* @__PURE__ */ u4(
        Field,
        {
          label: "Small model",
          info: "Lighter model for background tasks like compaction and summaries (cost optimization). Used by OpenCode; other providers may use in future.",
          children: /* @__PURE__ */ u4(
            ModelPickerDialog,
            {
              value: draft.small_model,
              provider: provider ?? data.defaults.provider,
              placeholder: "same as main model",
              disabled: busy,
              apiBasePath: apiPath(gid, ""),
              outputModality: "text",
              onChange: (v5) => update("small_model", v5)
            }
          )
        }
      ),
      /* @__PURE__ */ u4(
        Field,
        {
          label: "Transcription model",
          info: "OpenRouter model used when the main model cannot accept audio directly. When set, a mic button appears in the chat composer.\nLeave blank to disable voice input.",
          children: /* @__PURE__ */ u4(
            ModelPickerDialog,
            {
              value: draft.transcription_model,
              provider: "openrouter",
              placeholder: data.defaults.transcription_model || "google/gemini-2.0-flash-lite-001",
              disabled: busy,
              apiBasePath: apiPath(gid, ""),
              inputModality: "audio",
              onChange: (v5) => update("transcription_model", v5)
            }
          )
        }
      ),
      /* @__PURE__ */ u4(
        ModelParamsEditor,
        {
          gid,
          provider: draft.provider,
          value: draftModelParams,
          busy,
          onChange: setDraftModelParams
        }
      )
    ] }) : null,
    section === "settings" ? /* @__PURE__ */ u4(k, { children: [
      /* @__PURE__ */ u4(Field, { label: "Name", children: /* @__PURE__ */ u4(
        "input",
        {
          type: "text",
          value: draftName,
          disabled: busy,
          maxLength: 100,
          onInput: (e4) => setDraftName(e4.target.value)
        }
      ) }),
      /* @__PURE__ */ u4(Field, { label: "Effort", children: /* @__PURE__ */ u4(
        "input",
        {
          type: "text",
          value: draft.effort ?? "",
          disabled: busy,
          onInput: (e4) => update("effort", e4.currentTarget.value || null),
          placeholder: "provider-specific (e.g. high)"
        }
      ) }),
      /* @__PURE__ */ u4(Field, { label: "Image tag", children: /* @__PURE__ */ u4("div", { class: "group-admin-stack", children: [
        /* @__PURE__ */ u4(
          Combobox,
          {
            value: draft.image_tag,
            options: imageOptions,
            placeholder: data.defaults.image_tag ? `default: ${data.defaults.image_tag}` : "pick an image",
            disabled: busy,
            onChange: (v5) => update("image_tag", v5)
          }
        ),
        selectedImg ? /* @__PURE__ */ u4("div", { class: "group-admin-selected-info", children: [
          /* @__PURE__ */ u4("div", { class: "selected-title", children: [
            selectedImg.label,
            selectedImgAge || selectedImgSize ? /* @__PURE__ */ u4("span", { class: "selected-detail", children: [
              " \xB7 ",
              [selectedImgAge, selectedImgSize].filter(Boolean).join(" \xB7 ")
            ] }) : null,
            selectedImg.isDefault ? /* @__PURE__ */ u4("span", { class: "selected-detail", children: " \xB7 default" }) : null
          ] }),
          selectedImg.createdAt ? /* @__PURE__ */ u4("pre", { class: "selected-tooltip", children: [
            "Created: ",
            new Date(selectedImg.createdAt).toLocaleString()
          ] }) : null
        ] }) : draft.image_tag && images ? /* @__PURE__ */ u4("p", { class: "group-admin-help", children: "Tag not in local image list \u2014 will fail at container start if not pulled." }) : null
      ] }) }),
      /* @__PURE__ */ u4(Field, { label: "Assistant name", children: /* @__PURE__ */ u4(
        "input",
        {
          type: "text",
          value: draft.assistant_name ?? "",
          disabled: busy,
          onInput: (e4) => update("assistant_name", e4.currentTarget.value || null)
        }
      ) }),
      /* @__PURE__ */ u4(
        Field,
        {
          label: "Max messages / prompt",
          info: "Hard cap on how many history messages get included in each model call. Higher = more context but more cost; lower = faster + cheaper but the agent forgets sooner. Leave blank for the provider default.",
          children: /* @__PURE__ */ u4(
            "input",
            {
              type: "number",
              min: 1,
              max: 1e3,
              value: draft.max_messages_per_prompt ?? "",
              disabled: busy,
              onInput: (e4) => {
                const v5 = e4.currentTarget.value;
                update("max_messages_per_prompt", v5 ? Number(v5) : null);
              }
            }
          )
        }
      ),
      /* @__PURE__ */ u4(
        Field,
        {
          label: "CLI scope",
          info: "Controls which `ncl` commands an agent in this group can run.\ndisabled = no CLI access.\ngroup = limited to the group's own resources.\nglobal = unrestricted (owner / global admin only \u2014 use sparingly).",
          children: /* @__PURE__ */ u4(
            Combobox,
            {
              value: draft.cli_scope,
              options: data.validCliScopes.filter((s5) => s5 !== "global" || data.actorIsElevated || draft.cli_scope === "global").map((s5) => ({
                value: s5,
                label: s5,
                tooltip: s5 === "global" && !data.actorIsElevated ? "Owner / global admin only." : void 0
              })),
              placeholder: "pick a scope",
              disabled: busy,
              freeform: false,
              onChange: (v5) => update("cli_scope", v5)
            }
          )
        }
      ),
      data.site.available ? /* @__PURE__ */ u4(
        Field,
        {
          label: "Website",
          info: "Serve a public static website for this group from a folder in its workspace. Files in the FQDN-named folder become readable by anyone with the link \u2014 no login required. Separate from private file-share links.",
          children: /* @__PURE__ */ u4("div", { class: "group-admin-stack", children: [
            /* @__PURE__ */ u4("label", { class: "group-admin-check", children: [
              /* @__PURE__ */ u4(
                "input",
                {
                  type: "checkbox",
                  checked: siteEnabled,
                  disabled: busy,
                  onChange: (e4) => setSiteEnabled(e4.target.checked)
                }
              ),
              /* @__PURE__ */ u4("span", { children: "Enable website" })
            ] }),
            data.actorIsElevated ? /* @__PURE__ */ u4(
              "input",
              {
                type: "text",
                value: siteSlug,
                disabled: busy,
                maxLength: 63,
                placeholder: data.site.baseDomain ? `subdomain (.${data.site.baseDomain})` : "subdomain",
                onInput: (e4) => setSiteSlug(e4.currentTarget.value)
              }
            ) : null,
            siteEnabled && data.site.url ? /* @__PURE__ */ u4("p", { class: "group-admin-help", children: [
              "Live at ",
              /* @__PURE__ */ u4("a", { href: data.site.url, target: "_blank", rel: "noopener noreferrer", children: data.site.url }),
              " ",
              "\u2014 publish by writing files into the ",
              /* @__PURE__ */ u4("code", { children: data.site.fqdn }),
              " folder in the workspace."
            ] }) : siteEnabled ? /* @__PURE__ */ u4("p", { class: "group-admin-help", children: "Save to allocate a subdomain and go live." }) : /* @__PURE__ */ u4("p", { class: "group-admin-help", children: "Disabled \u2014 enable to publish a public static site on its own subdomain." })
          ] })
        }
      ) : null,
      /* @__PURE__ */ u4("div", { class: "group-admin-danger-zone", "data-testid": "danger-zone", children: /* @__PURE__ */ u4(
        "button",
        {
          type: "button",
          class: "danger",
          "data-testid": "archive-btn",
          disabled: busy || archiveBusy,
          onClick: () => {
            setArchiveConfirm("");
            setArchiveOpen(true);
          },
          children: "Archive group\u2026"
        }
      ) })
    ] }) : null,
    section === "packages" ? /* @__PURE__ */ u4(
      PackagesSection,
      {
        value: draftPackages,
        busy,
        onChange: setDraftPackages
      }
    ) : null,
    section === "mcp" ? /* @__PURE__ */ u4(
      McpServersSection,
      {
        value: draftMcpServers,
        busy,
        onChange: setDraftMcpServers
      }
    ) : null,
    section === "skills" ? /* @__PURE__ */ u4(
      SkillsSection,
      {
        value: draftSkills,
        busy,
        onChange: setDraftSkills
      }
    ) : null,
    /* @__PURE__ */ u4("div", { class: "settings-row group-admin-actions", style: "margin-top:16px", children: /* @__PURE__ */ u4("p", { class: "group-admin-help", children: changed ? `${pending2.size} unsaved change${pending2.size === 1 ? "" : "s"}. Click Save (\u2713) above to review and apply.` : "No unsaved changes." }) }),
    confirmOpen ? /* @__PURE__ */ u4(
      "div",
      {
        class: "settings-backdrop",
        onClick: (e4) => {
          if (e4.target.classList.contains("settings-backdrop") && !busy) setConfirmOpen(false);
        },
        children: /* @__PURE__ */ u4("div", { class: "settings-modal ga-confirm-modal", role: "dialog", "aria-label": "Apply changes", style: "max-width:440px", children: [
          /* @__PURE__ */ u4("header", { class: "settings-head", children: [
            /* @__PURE__ */ u4("span", { class: "title", children: "Apply changes" }),
            /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", disabled: busy, onClick: () => setConfirmOpen(false), children: "\u2715" })
          ] }),
          /* @__PURE__ */ u4("div", { class: "settings-body", children: [
            /* @__PURE__ */ u4("p", { class: "group-admin-help", style: "margin-bottom:12px", children: [
              pending2.size,
              " setting",
              pending2.size === 1 ? "" : "s",
              " will be saved:",
              " ",
              /* @__PURE__ */ u4("code", { children: [...pending2].join(", ") })
            ] }),
            /* @__PURE__ */ u4("div", { class: "ga-confirm-options", children: [
              /* @__PURE__ */ u4("label", { class: "group-admin-check", children: [
                /* @__PURE__ */ u4(
                  "input",
                  {
                    type: "checkbox",
                    checked: effectiveRestart,
                    disabled: busy || rebuildChecked,
                    onChange: (e4) => setRestartChecked(e4.target.checked)
                  }
                ),
                /* @__PURE__ */ u4("span", { children: "Restart sessions" }),
                /* @__PURE__ */ u4(Tooltip, { text: "Stop and respawn all running container sessions for this group so they pick up the saved config.\nDefaults on when you change provider, model, effort, image tag, assistant name, or max messages per prompt. CLI scope alone does not need a restart \u2014 it is re-read on every CLI call.\nActive conversations resume on the next user message.", children: /* @__PURE__ */ u4("span", { class: "info-icon", "aria-label": "More info", children: "i" }) })
              ] }),
              /* @__PURE__ */ u4("label", { class: "group-admin-check", children: [
                /* @__PURE__ */ u4(
                  "input",
                  {
                    type: "checkbox",
                    checked: rebuildChecked,
                    disabled: busy,
                    onChange: (e4) => setRebuildChecked(e4.target.checked)
                  }
                ),
                /* @__PURE__ */ u4("span", { children: "Rebuild image" }),
                /* @__PURE__ */ u4(Tooltip, { text: "Rebuild the container image before restarting.\nDefaults on when the chosen image tag does not exist locally. Otherwise normally only needed after `ncl groups config add-package` / `add-mcp-server` or a base-image change \u2014 that workflow lives in the CLI today, not this UI.\nA rebuild always implies a restart and takes minutes, not seconds.", children: /* @__PURE__ */ u4("span", { class: "info-icon", "aria-label": "More info", children: "i" }) })
              ] })
            ] }),
            needsRestart && !effectiveRestart ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: "These changes won\u2019t take effect until the sessions restart." }) : null
          ] }),
          /* @__PURE__ */ u4("footer", { class: "settings-foot ga-confirm-foot", children: [
            /* @__PURE__ */ u4("button", { type: "button", disabled: busy, onClick: () => setConfirmOpen(false), children: "Cancel" }),
            /* @__PURE__ */ u4("button", { type: "button", class: "primary", disabled: busy, onClick: doApply, children: busy ? "Applying\u2026" : effectiveRebuild ? "Save & rebuild" : effectiveRestart ? "Save & restart" : "Save" })
          ] })
        ] })
      }
    ) : null,
    archiveOpen ? /* @__PURE__ */ u4(
      "div",
      {
        class: "settings-backdrop",
        onClick: (e4) => {
          if (e4.target.classList.contains("settings-backdrop") && !archiveBusy) setArchiveOpen(false);
        },
        children: /* @__PURE__ */ u4("div", { class: "settings-modal ga-confirm-modal", role: "dialog", "aria-label": "Archive group", style: "max-width:440px", children: [
          /* @__PURE__ */ u4("header", { class: "settings-head", children: [
            /* @__PURE__ */ u4("span", { class: "title", children: "Archive group" }),
            /* @__PURE__ */ u4("button", { type: "button", class: "icon-btn", "aria-label": "Close", disabled: archiveBusy, onClick: () => setArchiveOpen(false), children: "\u2715" })
          ] }),
          /* @__PURE__ */ u4("div", { class: "settings-body", children: [
            /* @__PURE__ */ u4("p", { class: "group-admin-help", style: "margin-bottom:12px", children: [
              "Running container sessions will stop and the group will be removed from this UI. Its folder is renamed with a ",
              /* @__PURE__ */ u4("code", { children: "~" }),
              " suffix \u2014 nothing is deleted."
            ] }),
            /* @__PURE__ */ u4("p", { class: "group-admin-help", style: "margin-bottom:12px", children: [
              "Restore is host-only: ",
              /* @__PURE__ */ u4("code", { children: [
                "ncl groups restore --folder ",
                data.folder
              ] }),
              "."
            ] }),
            /* @__PURE__ */ u4("p", { class: "group-admin-help", style: "margin-bottom:8px", children: [
              "Type ",
              /* @__PURE__ */ u4("code", { children: data.folder }),
              " to confirm:"
            ] }),
            /* @__PURE__ */ u4(
              "input",
              {
                type: "text",
                "data-testid": "archive-confirm-input",
                value: archiveConfirm,
                disabled: archiveBusy,
                placeholder: data.folder,
                onInput: (e4) => setArchiveConfirm(e4.currentTarget.value)
              }
            )
          ] }),
          /* @__PURE__ */ u4("footer", { class: "settings-foot ga-confirm-foot", children: [
            /* @__PURE__ */ u4("button", { type: "button", disabled: archiveBusy, onClick: () => setArchiveOpen(false), children: "Cancel" }),
            /* @__PURE__ */ u4(
              "button",
              {
                type: "button",
                class: "danger",
                "data-testid": "archive-confirm-btn",
                disabled: archiveBusy || archiveConfirm.trim() !== data.folder,
                onClick: doArchive,
                children: archiveBusy ? "Archiving\u2026" : "Archive group"
              }
            )
          ] })
        ] })
      }
    ) : null
  ] });
}
function Field({
  label,
  info,
  children
}) {
  return /* @__PURE__ */ u4("div", { class: "settings-row group-admin-field", children: [
    /* @__PURE__ */ u4("label", { class: "group-admin-label", children: [
      label,
      info ? /* @__PURE__ */ u4(InfoIcon, { text: info }) : null
    ] }),
    /* @__PURE__ */ u4("div", { class: "group-admin-control", children })
  ] });
}
function MembersTab({ gid }) {
  const [members, setMembers] = h2(null);
  const [busy, setBusy] = h2(false);
  async function refresh() {
    const r4 = await call(apiPath(gid, "/members"));
    if (!r4.ok) {
      showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
      return;
    }
    setMembers(r4.data.members);
  }
  y2(() => {
    refresh();
  }, [gid]);
  async function add(userId) {
    setBusy(true);
    try {
      const r4 = await call(apiPath(gid, "/members"), "POST", { userId });
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      showToast("Member added");
      refresh();
    } finally {
      setBusy(false);
    }
  }
  async function remove(m6) {
    setBusy(true);
    try {
      const r4 = await call(apiPath(gid, `/members/${encodeURIComponent(m6.userId)}`), "DELETE");
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      showToast("Member removed");
      refresh();
    } finally {
      setBusy(false);
    }
  }
  if (!members) return /* @__PURE__ */ u4("p", { class: "muted", children: "Loading\u2026" });
  return /* @__PURE__ */ u4("section", { children: [
    /* @__PURE__ */ u4("p", { class: "muted", children: 'Members can interact with this group when channel routing requires "known" senders. Admins of the group are implicit members (shown below for context).' }),
    members.length === 0 ? /* @__PURE__ */ u4("p", { class: "muted", children: "No members yet." }) : /* @__PURE__ */ u4("table", { class: "settings-table", children: [
      /* @__PURE__ */ u4("thead", { children: /* @__PURE__ */ u4("tr", { children: [
        /* @__PURE__ */ u4("th", { children: "Name" }),
        /* @__PURE__ */ u4("th", { children: "Identity" }),
        /* @__PURE__ */ u4("th", {})
      ] }) }),
      /* @__PURE__ */ u4("tbody", { children: members.map((m6) => /* @__PURE__ */ u4("tr", { children: [
        /* @__PURE__ */ u4("td", { children: [
          m6.displayName || /* @__PURE__ */ u4("span", { class: "muted", children: "(no name)" }),
          m6.isAdmin ? /* @__PURE__ */ u4("span", { class: "group-admin-badge", title: "Admin of this group", children: "admin" }) : null
        ] }),
        /* @__PURE__ */ u4("td", { children: m6.primaryHandle ? /* @__PURE__ */ u4("code", { children: [
          m6.primaryChannel,
          ":",
          m6.primaryHandle
        ] }) : /* @__PURE__ */ u4("code", { class: "muted", children: m6.userId }) }),
        /* @__PURE__ */ u4("td", { children: m6.isExplicitMember && !m6.isAdmin ? /* @__PURE__ */ u4("button", { type: "button", class: "danger", disabled: busy, onClick: () => remove(m6), children: "Remove" }) : /* @__PURE__ */ u4("span", { class: "muted", children: m6.isAdmin ? "implicit" : "" }) })
      ] }, m6.userId)) })
    ] }),
    /* @__PURE__ */ u4("h4", { children: "Add a member" }),
    /* @__PURE__ */ u4(
      UserPicker,
      {
        gid,
        excludeUserIds: new Set(members.map((m6) => m6.userId)),
        disabled: busy,
        onPick: add
      }
    )
  ] });
}
function RolesTab({ gid }) {
  const [admins, setAdmins] = h2(null);
  const [busy, setBusy] = h2(false);
  async function refresh() {
    const r4 = await call(apiPath(gid, "/roles"));
    if (!r4.ok) {
      showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
      return;
    }
    setAdmins(r4.data.admins);
  }
  y2(() => {
    refresh();
  }, [gid]);
  async function grant(userId) {
    setBusy(true);
    try {
      const r4 = await call(
        apiPath(gid, "/roles"),
        "POST",
        { userId }
      );
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      showToast(r4.data.alreadyGranted ? "Already an admin" : "Admin granted");
      refresh();
    } finally {
      setBusy(false);
    }
  }
  async function revoke(a4) {
    setBusy(true);
    try {
      const r4 = await call(apiPath(gid, `/roles/${encodeURIComponent(a4.userId)}`), "DELETE");
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      showToast("Admin revoked");
      refresh();
    } finally {
      setBusy(false);
    }
  }
  if (!admins) return /* @__PURE__ */ u4("p", { class: "muted", children: "Loading\u2026" });
  return /* @__PURE__ */ u4("section", { children: [
    /* @__PURE__ */ u4("p", { class: "muted", children: "Admins of this group can change its settings, manage members, and grant/revoke admin on this group only. Global owner and global admins are not shown here \u2014 they manage all groups system-wide." }),
    admins.length === 0 ? /* @__PURE__ */ u4("p", { class: "muted", children: "No scoped admins. (Global admins still have full access.)" }) : /* @__PURE__ */ u4("table", { class: "settings-table", children: [
      /* @__PURE__ */ u4("thead", { children: /* @__PURE__ */ u4("tr", { children: [
        /* @__PURE__ */ u4("th", { children: "Name" }),
        /* @__PURE__ */ u4("th", { children: "Identity" }),
        /* @__PURE__ */ u4("th", {})
      ] }) }),
      /* @__PURE__ */ u4("tbody", { children: admins.map((a4) => /* @__PURE__ */ u4("tr", { children: [
        /* @__PURE__ */ u4("td", { children: a4.displayName || /* @__PURE__ */ u4("span", { class: "muted", children: "(no name)" }) }),
        /* @__PURE__ */ u4("td", { children: a4.primaryHandle ? /* @__PURE__ */ u4("code", { children: [
          a4.primaryChannel,
          ":",
          a4.primaryHandle
        ] }) : /* @__PURE__ */ u4("code", { class: "muted", children: a4.userId }) }),
        /* @__PURE__ */ u4("td", { children: /* @__PURE__ */ u4("button", { type: "button", class: "danger", disabled: busy, onClick: () => revoke(a4), children: "Revoke" }) })
      ] }, a4.userId)) })
    ] }),
    /* @__PURE__ */ u4("h4", { children: "Grant admin" }),
    /* @__PURE__ */ u4(
      UserPicker,
      {
        gid,
        excludeUserIds: new Set(admins.map((a4) => a4.userId)),
        disabled: busy,
        onPick: grant
      }
    )
  ] });
}
function formatChannelHandle(channelType2, platformId, targetId) {
  if (!channelType2 && !platformId) return targetId;
  if (!channelType2) return platformId ?? targetId;
  if (!platformId) return channelType2;
  return platformId.startsWith(`${channelType2}:`) ? platformId : `${channelType2}:${platformId}`;
}
function DestinationsTab({ gid }) {
  const [destinations, setDestinations] = h2(null);
  const [adding, setAdding] = h2(false);
  const [busy, setBusy] = h2(false);
  async function refresh() {
    const r4 = await call(apiPath(gid, "/destinations"));
    if (!r4.ok) {
      showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
      return;
    }
    setDestinations(r4.data.destinations);
  }
  y2(() => {
    refresh();
  }, [gid]);
  async function remove(d5) {
    if (!confirm(`Remove destination "${d5.localName}"?`)) return;
    setBusy(true);
    try {
      const r4 = await call(apiPath(gid, `/destinations/${encodeURIComponent(d5.localName)}`), "DELETE");
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      showToast("Destination removed");
      refresh();
    } finally {
      setBusy(false);
    }
  }
  async function removeReverse(d5) {
    if (!d5.reverseLink) return;
    if (!confirm(`Remove the reverse link "${d5.reverseLink.localName}" in "${d5.targetName ?? d5.targetId}"?`)) return;
    setBusy(true);
    try {
      const r4 = await call(
        apiPath(gid, `/destinations/${encodeURIComponent(d5.localName)}/reverse`),
        "DELETE"
      );
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      showToast("Reverse link removed");
      refresh();
    } finally {
      setBusy(false);
    }
  }
  if (!destinations) return /* @__PURE__ */ u4("p", { class: "muted", children: "Loading\u2026" });
  const agents = destinations.filter((d5) => d5.targetType === "agent");
  const channels = destinations.filter((d5) => d5.targetType === "channel");
  return /* @__PURE__ */ u4("section", { children: [
    /* @__PURE__ */ u4("p", { class: "muted", children: "Destinations are the names this agent uses to route messages \u2014 either to channels (auto-managed, listed below) or to other agent groups (added here)." }),
    /* @__PURE__ */ u4("h4", { children: "Agent destinations" }),
    agents.length === 0 ? /* @__PURE__ */ u4("p", { class: "muted", children: "No agent destinations yet." }) : /* @__PURE__ */ u4("table", { class: "settings-table ga-destinations-table", children: [
      /* @__PURE__ */ u4("thead", { children: /* @__PURE__ */ u4("tr", { children: [
        /* @__PURE__ */ u4("th", { children: "Target agent" }),
        /* @__PURE__ */ u4("th", { children: "Local name" }),
        /* @__PURE__ */ u4("th", { children: "Reverse link" }),
        /* @__PURE__ */ u4("th", {})
      ] }) }),
      /* @__PURE__ */ u4("tbody", { children: agents.map((d5) => /* @__PURE__ */ u4("tr", { children: [
        /* @__PURE__ */ u4("td", { children: [
          /* @__PURE__ */ u4("div", { children: d5.targetName ?? /* @__PURE__ */ u4("span", { class: "muted", children: "(unnamed)" }) }),
          /* @__PURE__ */ u4("code", { class: "muted ga-id-sub", children: d5.targetId })
        ] }),
        /* @__PURE__ */ u4("td", { children: /* @__PURE__ */ u4("code", { children: d5.localName }) }),
        /* @__PURE__ */ u4("td", { children: d5.reverseLink ? /* @__PURE__ */ u4("span", { class: "ga-reverse", children: [
          /* @__PURE__ */ u4("code", { children: d5.reverseLink.localName }),
          d5.reverseLink.viewerCanRemove ? /* @__PURE__ */ u4(
            "button",
            {
              type: "button",
              class: "ga-reverse-x",
              title: `Remove reverse link "${d5.reverseLink.localName}" in target group`,
              disabled: busy,
              onClick: () => removeReverse(d5),
              children: "\xD7"
            }
          ) : /* @__PURE__ */ u4(Tooltip, { text: "You must be an admin of the target group to remove its destinations.", children: /* @__PURE__ */ u4("span", { class: "muted ga-id-sub", children: "(target-admin only)" }) })
        ] }) : /* @__PURE__ */ u4("span", { class: "muted", children: "\u2014" }) }),
        /* @__PURE__ */ u4("td", { children: /* @__PURE__ */ u4("button", { type: "button", class: "danger", disabled: busy, onClick: () => remove(d5), children: "Remove" }) })
      ] }, d5.localName)) })
    ] }),
    /* @__PURE__ */ u4("p", { class: "muted ga-hint", children: [
      'A "reverse link" is a destination row in the ',
      /* @__PURE__ */ u4("em", { children: "target" }),
      " group's table pointing back at this one \u2014 created either by ticking the box when you add the link, or by an admin of that group adding it independently. Either way it shows up here."
    ] }),
    /* @__PURE__ */ u4("h4", { children: "Add an agent link" }),
    adding ? /* @__PURE__ */ u4(AddDestinationForm, { gid, onCancel: () => setAdding(false), onDone: () => {
      setAdding(false);
      refresh();
    } }) : /* @__PURE__ */ u4("button", { type: "button", onClick: () => setAdding(true), children: "Link another agent\u2026" }),
    /* @__PURE__ */ u4("h4", { class: "ga-section-h4", children: "Channel destinations" }),
    /* @__PURE__ */ u4("p", { class: "muted", children: "Channels (chat platforms, email, web) are wired automatically when a messaging group is connected to this agent \u2014 read-only here." }),
    channels.length === 0 ? /* @__PURE__ */ u4("p", { class: "muted", children: "No channel destinations." }) : /* @__PURE__ */ u4("table", { class: "settings-table ga-destinations-table", children: [
      /* @__PURE__ */ u4("thead", { children: /* @__PURE__ */ u4("tr", { children: [
        /* @__PURE__ */ u4("th", { children: "Channel" }),
        /* @__PURE__ */ u4("th", { children: "Local name" })
      ] }) }),
      /* @__PURE__ */ u4("tbody", { children: channels.map((d5) => /* @__PURE__ */ u4("tr", { children: [
        /* @__PURE__ */ u4("td", { children: [
          /* @__PURE__ */ u4("div", { children: d5.targetName ?? /* @__PURE__ */ u4("span", { class: "muted", children: "(unnamed)" }) }),
          /* @__PURE__ */ u4("code", { class: "muted ga-id-sub", children: formatChannelHandle(d5.channelType, d5.platformId, d5.targetId) })
        ] }),
        /* @__PURE__ */ u4("td", { children: /* @__PURE__ */ u4("code", { children: d5.localName }) })
      ] }, d5.localName)) })
    ] })
  ] });
}
function AddDestinationForm({ gid, onCancel, onDone }) {
  const [candidates, setCandidates] = h2(null);
  const [targetId, setTargetId] = h2("");
  const [localName, setLocalName] = h2("");
  const [alsoReverse, setAlsoReverse] = h2(false);
  const [busy, setBusy] = h2(false);
  y2(() => {
    (async () => {
      const r4 = await call(apiPath(gid, "/destinations/candidates"));
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      setCandidates(r4.data.candidates);
    })();
  }, [gid]);
  const selected = candidates?.find((c4) => c4.id === targetId) ?? null;
  async function submit(e4) {
    e4.preventDefault();
    if (!targetId || !localName.trim()) return;
    setBusy(true);
    try {
      const r4 = await call(
        apiPath(gid, "/destinations"),
        "POST",
        { targetAgentGroupId: targetId, localName: localName.trim(), alsoReverse }
      );
      if (!r4.ok) {
        showToast(errMsg2(r4.data, `HTTP ${r4.status}`), "err");
        return;
      }
      showToast(r4.data.status === "applied" ? "Destination added" : "Approval requested");
      onDone();
    } finally {
      setBusy(false);
    }
  }
  if (!candidates) return /* @__PURE__ */ u4("p", { class: "muted", children: "Loading candidates\u2026" });
  if (candidates.length === 0) return /* @__PURE__ */ u4("div", { children: [
    /* @__PURE__ */ u4("p", { class: "muted", children: "No eligible target groups. You must be an admin (or member, when admin-on-target) of another agent group to link it." }),
    /* @__PURE__ */ u4("button", { type: "button", onClick: onCancel, children: "Cancel" })
  ] });
  const options = candidates.map((c4) => ({
    value: c4.id,
    label: c4.name,
    detail: c4.adminOnTarget ? c4.folder : `${c4.folder} \xB7 needs approval`,
    tooltip: c4.adminOnTarget ? `You are an admin of "${c4.name}". Linking will apply immediately.` : `You are not an admin of "${c4.name}". An admin of that group will be asked to approve the link.`
  }));
  return /* @__PURE__ */ u4("form", { onSubmit: submit, class: "ga-add-link-form", children: [
    /* @__PURE__ */ u4(Field, { label: "Target agent group", children: /* @__PURE__ */ u4(
      Combobox,
      {
        value: targetId || null,
        options,
        placeholder: "Search by name or id\u2026",
        disabled: busy,
        freeform: false,
        onChange: (v5) => setTargetId(v5 ?? "")
      }
    ) }),
    /* @__PURE__ */ u4(Field, { label: "Local name", children: /* @__PURE__ */ u4(
      "input",
      {
        type: "text",
        value: localName,
        onInput: (e4) => setLocalName(e4.target.value),
        placeholder: selected?.folder ?? "e.g. research-bot",
        disabled: busy
      }
    ) }),
    /* @__PURE__ */ u4(Field, { label: "Reverse link", children: /* @__PURE__ */ u4("label", { class: "ga-checkbox", children: [
      /* @__PURE__ */ u4(
        "input",
        {
          type: "checkbox",
          checked: alsoReverse,
          onChange: (e4) => setAlsoReverse(e4.target.checked),
          disabled: busy
        }
      ),
      "Also let the target agent send back to this one"
    ] }) }),
    selected && !selected.adminOnTarget ? /* @__PURE__ */ u4("p", { class: "muted ga-hint", children: [
      'You are not an admin of "',
      selected.name,
      '" \u2014 an admin of that group will be asked to approve this link.'
    ] }) : null,
    /* @__PURE__ */ u4("div", { class: "settings-actions", children: [
      /* @__PURE__ */ u4("button", { type: "submit", disabled: busy || !targetId || !localName.trim(), children: selected?.adminOnTarget ? "Add" : "Request" }),
      /* @__PURE__ */ u4("button", { type: "button", onClick: onCancel, disabled: busy, children: "Cancel" })
    ] })
  ] });
}
function UserPicker({
  gid,
  excludeUserIds,
  disabled,
  onPick
}) {
  const [q5, setQ] = h2("");
  const [results, setResults] = h2([]);
  const [searching, setSearching] = h2(false);
  y2(() => {
    let cancelled = false;
    const t4 = setTimeout(async () => {
      setSearching(true);
      try {
        const r4 = await call(
          apiPath(gid, `/users-search?q=${encodeURIComponent(q5)}`)
        );
        if (!cancelled && r4.ok) setResults(r4.data.users);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t4);
    };
  }, [q5, gid]);
  const visible = results.filter((u5) => !excludeUserIds.has(u5.userId)).slice(0, 20);
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4("div", { class: "settings-row", children: /* @__PURE__ */ u4(
      "input",
      {
        type: "text",
        placeholder: "Search name, handle, or user id",
        value: q5,
        onInput: (e4) => setQ(e4.currentTarget.value),
        disabled
      }
    ) }),
    searching && visible.length === 0 ? /* @__PURE__ */ u4("p", { class: "muted", children: "Searching\u2026" }) : null,
    visible.length > 0 ? /* @__PURE__ */ u4("ul", { class: "group-admin-search-results", children: visible.map((u5) => /* @__PURE__ */ u4("li", { children: /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "group-admin-search-row",
        disabled,
        onClick: () => onPick(u5.userId),
        children: [
          /* @__PURE__ */ u4("span", { class: "group-admin-search-name", children: u5.displayName || u5.userId }),
          /* @__PURE__ */ u4("span", { class: "group-admin-search-handle", children: u5.primaryHandle ? `${u5.primaryChannel}:${u5.primaryHandle}` : u5.kind })
        ]
      }
    ) }, u5.userId)) }) : null,
    !searching && q5 && visible.length === 0 ? /* @__PURE__ */ u4("p", { class: "muted", children: "No matches." }) : null
  ] });
}
var MODEL_PARAM_RECOGNIZED = {
  opencode: ["max_tokens", "temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "seed", "stop"],
  claude: ["max_tokens", "thinking_budget_tokens"]
};
var MODEL_PARAM_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
var _rowUid = 0;
function nextRowUid() {
  _rowUid += 1;
  return _rowUid;
}
function paramsToRows(params) {
  return Object.entries(params).map(([k4, v5]) => ({
    uid: nextRowUid(),
    key: k4,
    // Stringify in a JSON-roundtrippable form so the user can edit & resave.
    valueText: typeof v5 === "string" ? v5 : JSON.stringify(v5)
  }));
}
function parseRowValue(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}
function rowsToParams(rows) {
  const out = {};
  const seen = /* @__PURE__ */ new Set();
  for (const r4 of rows) {
    const k4 = r4.key.trim();
    if (k4 === "" && r4.valueText.trim() === "") continue;
    if (!k4 || !MODEL_PARAM_KEY_RE.test(k4) || seen.has(k4)) continue;
    seen.add(k4);
    out[k4] = parseRowValue(r4.valueText);
  }
  return out;
}
function ModelParamsEditor({
  gid,
  provider,
  value,
  busy,
  onChange
}) {
  const [rows, setRows] = h2(() => paramsToRows(value));
  const lastEmittedRef = A2(JSON.stringify(value));
  y2(() => {
    const incoming = JSON.stringify(value);
    if (incoming === lastEmittedRef.current) return;
    setRows(paramsToRows(value));
    lastEmittedRef.current = incoming;
  }, [value]);
  const recognized = provider ? MODEL_PARAM_RECOGNIZED[provider] ?? [] : [];
  function emit(next) {
    const params = rowsToParams(next);
    lastEmittedRef.current = JSON.stringify(params);
    onChange(params);
  }
  function update(uid, patch) {
    setRows((rs) => {
      const next = rs.map((r4) => r4.uid === uid ? { ...r4, ...patch } : r4);
      emit(next);
      return next;
    });
  }
  function remove(uid) {
    setRows((rs) => {
      const next = rs.filter((r4) => r4.uid !== uid);
      emit(next);
      return next;
    });
  }
  function addBlank(presetKey = "") {
    setRows((rs) => {
      const next = [...rs, { uid: nextRowUid(), key: presetKey, valueText: "" }];
      emit(next);
      return next;
    });
  }
  const issues = [];
  const seenKeys = /* @__PURE__ */ new Set();
  for (const r4 of rows) {
    const k4 = r4.key.trim();
    if (k4 === "" && r4.valueText.trim() === "") continue;
    if (k4 === "") {
      issues.push("A row is missing a key.");
      continue;
    }
    if (!MODEL_PARAM_KEY_RE.test(k4)) {
      issues.push(`Invalid key "${k4}".`);
      continue;
    }
    if (seenKeys.has(k4)) {
      issues.push(`Duplicate key "${k4}".`);
      continue;
    }
    seenKeys.add(k4);
  }
  const suggestions = recognized.filter((k4) => !rows.some((r4) => r4.key.trim() === k4));
  return /* @__PURE__ */ u4(
    Field,
    {
      label: "Model parameters",
      info: 'Per-group knobs passed to the provider when it builds requests (max_tokens, temperature, \u2026).\nValues are parsed as JSON first (so 8192 is a number, "high" is a string, true is a boolean), then fall back to a plain string if JSON parsing fails.\nChanges take effect on next container restart. Providers warn once per startup about keys they do not recognize.',
      children: /* @__PURE__ */ u4("div", { class: "group-admin-stack ga-model-params", children: [
        rows.length === 0 ? /* @__PURE__ */ u4("p", { class: "group-admin-help", children: "No parameters set \u2014 using provider defaults." }) : /* @__PURE__ */ u4("ul", { class: "ga-mp-list", children: rows.map((r4) => {
          const trimmedKey = r4.key.trim();
          const isRecognized = trimmedKey !== "" && recognized.includes(trimmedKey);
          return /* @__PURE__ */ u4("li", { class: "ga-mp-row", children: [
            /* @__PURE__ */ u4(
              "input",
              {
                type: "text",
                class: `ga-mp-key${trimmedKey !== "" && !isRecognized && recognized.length > 0 ? " ga-mp-key-unknown" : ""}`,
                placeholder: "key (e.g. max_tokens)",
                value: r4.key,
                disabled: busy,
                list: `ga-mp-keys-${gid}`,
                onInput: (e4) => update(r4.uid, { key: e4.currentTarget.value })
              }
            ),
            /* @__PURE__ */ u4(
              "input",
              {
                type: "text",
                class: "ga-mp-value",
                placeholder: "value (JSON or string)",
                value: r4.valueText,
                disabled: busy,
                onInput: (e4) => update(r4.uid, { valueText: e4.currentTarget.value })
              }
            ),
            /* @__PURE__ */ u4(
              "button",
              {
                type: "button",
                class: "icon-btn",
                "aria-label": "Remove",
                disabled: busy,
                onClick: () => remove(r4.uid),
                children: "\u2715"
              }
            )
          ] }, r4.uid);
        }) }),
        /* @__PURE__ */ u4("datalist", { id: `ga-mp-keys-${gid}`, children: recognized.map((k4) => /* @__PURE__ */ u4("option", { value: k4 }, k4)) }),
        /* @__PURE__ */ u4("div", { class: "ga-mp-actions", children: [
          /* @__PURE__ */ u4("button", { type: "button", disabled: busy, onClick: () => addBlank(), children: "+ Add parameter" }),
          suggestions.length > 0 ? /* @__PURE__ */ u4("span", { class: "ga-mp-suggest", children: [
            /* @__PURE__ */ u4("span", { class: "group-admin-help", children: [
              "Common for ",
              provider,
              ":"
            ] }),
            suggestions.map((k4) => /* @__PURE__ */ u4(
              "button",
              {
                type: "button",
                class: "ga-mp-suggest-chip",
                disabled: busy,
                onClick: () => addBlank(k4),
                title: `Add ${k4}`,
                children: [
                  "+ ",
                  k4
                ]
              },
              k4
            ))
          ] }) : null
        ] }),
        issues.length > 0 ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: issues[0] }) : null
      ] })
    }
  );
}
var PACKAGE_TOKEN_RE = /^[A-Za-z0-9@._/+=<>~^!*-]+$/;
var MCP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
var SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
function PackagesSection({
  value,
  busy,
  onChange
}) {
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4("div", { class: "group-admin-toolbar", children: /* @__PURE__ */ u4("p", { class: "group-admin-help", children: [
      "Packages baked into the container image. Changes require an image rebuild \u2014 the Apply dialog suggests rebuild when any list here changes. Mirrors",
      " ",
      /* @__PURE__ */ u4("code", { children: "ncl groups config add-package / remove-package" }),
      "."
    ] }) }),
    /* @__PURE__ */ u4(
      PackageListField,
      {
        label: "apt packages",
        info: "Debian packages installed via apt-get in the agent image. Example: ripgrep, jq, postgresql-client.",
        placeholder: "apt package (e.g. ripgrep, jq, postgresql-client)",
        items: value.apt,
        disabled: busy,
        onChange: (apt) => onChange({ ...value, apt })
      }
    ),
    /* @__PURE__ */ u4(
      PackageListField,
      {
        label: "npm packages",
        info: "Node packages installed globally via pnpm/npm in the agent image. Example: typescript@5, prettier.",
        placeholder: "npm package (e.g. typescript@5, prettier)",
        items: value.npm,
        disabled: busy,
        onChange: (npm) => onChange({ ...value, npm })
      }
    ),
    /* @__PURE__ */ u4(
      PackageListField,
      {
        label: "pip packages",
        info: "Python packages installed via pip in the agent image. Example: requests, pandas==2.0.0.",
        placeholder: "pip package (e.g. requests, pandas==2.0.0)",
        items: value.pip,
        disabled: busy,
        onChange: (pip) => onChange({ ...value, pip })
      }
    )
  ] });
}
function PackageListField({
  label,
  info,
  placeholder,
  items,
  disabled,
  onChange
}) {
  const [draft, setDraft] = h2("");
  const trimmed = draft.trim();
  const isDup = trimmed !== "" && items.includes(trimmed);
  const isInvalid = trimmed !== "" && !PACKAGE_TOKEN_RE.test(trimmed);
  const canAdd = trimmed !== "" && !isDup && !isInvalid;
  function add() {
    if (!canAdd) return;
    onChange([...items, trimmed]);
    setDraft("");
  }
  function remove(idx) {
    onChange(items.filter((_6, i5) => i5 !== idx));
  }
  return /* @__PURE__ */ u4(Field, { label, info, children: /* @__PURE__ */ u4("div", { class: "group-admin-stack ga-model-params", children: [
    items.length === 0 ? /* @__PURE__ */ u4("p", { class: "group-admin-help", children: "No packages." }) : /* @__PURE__ */ u4("ul", { class: "ga-chip-list", children: items.map((p5, i5) => /* @__PURE__ */ u4("li", { class: "ga-chip", children: [
      /* @__PURE__ */ u4("span", { class: "ga-chip-label", children: p5 }),
      /* @__PURE__ */ u4(
        "button",
        {
          type: "button",
          class: "ga-chip-remove",
          "aria-label": `Remove ${p5}`,
          disabled,
          onClick: () => remove(i5),
          children: "\u2715"
        }
      )
    ] }, `${p5}-${i5}`)) }),
    /* @__PURE__ */ u4("div", { class: "ga-mp-actions", children: [
      /* @__PURE__ */ u4(
        "input",
        {
          type: "text",
          class: "ga-chip-input",
          placeholder,
          value: draft,
          disabled,
          onInput: (e4) => setDraft(e4.currentTarget.value),
          onKeyDown: (e4) => {
            if (e4.key === "Enter") {
              e4.preventDefault();
              add();
            }
          }
        }
      ),
      /* @__PURE__ */ u4("button", { type: "button", disabled: disabled || !canAdd, onClick: add, children: "+ Add" })
    ] }),
    isInvalid ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: [
      '"',
      trimmed,
      '" has invalid characters.'
    ] }) : isDup ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: [
      '"',
      trimmed,
      '" is already in the list.'
    ] }) : null
  ] }) });
}
function McpServersSection({
  value,
  busy,
  onChange
}) {
  const names = Object.keys(value);
  const [newName, setNewName] = h2("");
  const trimmedNew = newName.trim();
  const newNameInvalid = trimmedNew !== "" && !MCP_NAME_RE.test(trimmedNew);
  const newNameDup = trimmedNew !== "" && trimmedNew in value;
  const canAdd = trimmedNew !== "" && !newNameInvalid && !newNameDup;
  function addServer() {
    if (!canAdd) return;
    onChange({ ...value, [trimmedNew]: { command: "" } });
    setNewName("");
  }
  function removeServer(name) {
    const next = { ...value };
    delete next[name];
    onChange(next);
  }
  function updateServer(name, patch) {
    onChange({ ...value, [name]: patch });
  }
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4("div", { class: "group-admin-toolbar", children: /* @__PURE__ */ u4("p", { class: "group-admin-help", children: [
      "MCP (Model Context Protocol) servers wired into this group's agents. Restart required to take effect \u2014 the SDK builds the MCP map at session start. Mirrors",
      " ",
      /* @__PURE__ */ u4("code", { children: "ncl groups config add-mcp-server / remove-mcp-server" }),
      "."
    ] }) }),
    names.length === 0 ? /* @__PURE__ */ u4("p", { class: "group-admin-help", style: "margin:8px 0 16px", children: "No MCP servers configured." }) : names.map((name) => /* @__PURE__ */ u4(
      McpServerCard,
      {
        name,
        value: value[name],
        disabled: busy,
        onChange: (next) => updateServer(name, next),
        onRemove: () => removeServer(name)
      },
      name
    )),
    /* @__PURE__ */ u4(Field, { label: "Add server", info: "Name is the key the agent uses to reference this server's tools. Letters, digits, _, ., - only.", children: [
      /* @__PURE__ */ u4("div", { class: "ga-mp-actions", children: [
        /* @__PURE__ */ u4(
          "input",
          {
            type: "text",
            class: "ga-chip-input",
            placeholder: "server name (e.g. context7, fetch)",
            value: newName,
            disabled: busy,
            onInput: (e4) => setNewName(e4.currentTarget.value),
            onKeyDown: (e4) => {
              if (e4.key === "Enter") {
                e4.preventDefault();
                addServer();
              }
            }
          }
        ),
        /* @__PURE__ */ u4("button", { type: "button", disabled: busy || !canAdd, onClick: addServer, children: "+ Add server" })
      ] }),
      newNameInvalid ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: "Name must start with a letter or _, then letters/digits/_/./-." }) : newNameDup ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: [
        '"',
        trimmedNew,
        '" already exists.'
      ] }) : null
    ] })
  ] });
}
function McpServerCard({
  name,
  value,
  disabled,
  onChange,
  onRemove
}) {
  const rawType = value.type;
  const type = rawType === "http" || rawType === "sse" ? rawType : "stdio";
  function setType(next) {
    if (next === "stdio") {
      const stdio = value;
      onChange({
        type: "stdio",
        command: stdio.command ?? "",
        ...stdio.args ? { args: stdio.args } : {},
        ...stdio.env ? { env: stdio.env } : {},
        ...value.instructions ? { instructions: value.instructions } : {},
        ...value.timeout ? { timeout: value.timeout } : {}
      });
    } else {
      const http = value;
      onChange({
        type: next,
        url: http.url ?? "",
        ...http.headers ? { headers: http.headers } : {},
        ...value.instructions ? { instructions: value.instructions } : {},
        ...value.timeout ? { timeout: value.timeout } : {}
      });
    }
  }
  return /* @__PURE__ */ u4("div", { class: "ga-mcp-card", children: [
    /* @__PURE__ */ u4("div", { class: "ga-mcp-card-head", children: [
      /* @__PURE__ */ u4("strong", { class: "ga-mcp-card-name", children: name }),
      /* @__PURE__ */ u4(
        "select",
        {
          class: "ga-mcp-type",
          value: type,
          disabled,
          onChange: (e4) => setType(e4.currentTarget.value),
          children: [
            /* @__PURE__ */ u4("option", { value: "stdio", children: "stdio" }),
            /* @__PURE__ */ u4("option", { value: "http", children: "http" }),
            /* @__PURE__ */ u4("option", { value: "sse", children: "sse" })
          ]
        }
      ),
      /* @__PURE__ */ u4(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": `Remove ${name}`,
          disabled,
          onClick: onRemove,
          children: "\u2715"
        }
      )
    ] }),
    type === "stdio" ? /* @__PURE__ */ u4(
      McpStdioFields,
      {
        value,
        disabled,
        onChange
      }
    ) : /* @__PURE__ */ u4(
      McpHttpFields,
      {
        value,
        disabled,
        onChange
      }
    ),
    /* @__PURE__ */ u4("label", { class: "ga-mcp-row", children: [
      /* @__PURE__ */ u4("span", { class: "ga-mcp-row-label", children: "instructions" }),
      /* @__PURE__ */ u4(
        "textarea",
        {
          class: "ga-mcp-textarea",
          placeholder: "optional one-line description shown to the agent",
          rows: 2,
          value: value.instructions ?? "",
          disabled,
          onInput: (e4) => {
            const v5 = e4.currentTarget.value;
            onChange({ ...value, instructions: v5 || void 0 });
          }
        }
      )
    ] }),
    /* @__PURE__ */ u4("label", { class: "ga-mcp-row", children: [
      /* @__PURE__ */ u4("span", { class: "ga-mcp-row-label", children: "timeout (ms)" }),
      /* @__PURE__ */ u4(
        "input",
        {
          type: "number",
          class: "ga-mcp-input",
          placeholder: "default 60000",
          min: 1e3,
          max: 6e5,
          step: 1e3,
          value: value.timeout ?? "",
          disabled,
          onInput: (e4) => {
            const raw = e4.currentTarget.value.trim();
            const n3 = raw === "" ? void 0 : Number(raw);
            onChange({
              ...value,
              timeout: n3 != null && Number.isFinite(n3) ? n3 : void 0
            });
          }
        }
      )
    ] })
  ] });
}
function McpStdioFields({
  value,
  disabled,
  onChange
}) {
  const argsText = value.args ? JSON.stringify(value.args) : "";
  const envText = value.env ? JSON.stringify(value.env, null, 2) : "";
  const [argsDraft, setArgsDraft] = h2(argsText);
  const [envDraft, setEnvDraft] = h2(envText);
  y2(() => {
    setArgsDraft(value.args ? JSON.stringify(value.args) : "");
  }, [JSON.stringify(value.args ?? [])]);
  y2(() => {
    setEnvDraft(value.env ? JSON.stringify(value.env, null, 2) : "");
  }, [JSON.stringify(value.env ?? {})]);
  const argsParsed = parseJsonStringArray(argsDraft);
  const envParsed = parseJsonStringMap(envDraft);
  function commitArgs(text) {
    setArgsDraft(text);
    const parsed = parseJsonStringArray(text);
    if (parsed.ok) {
      const next = { ...value };
      if (parsed.value.length === 0) delete next.args;
      else next.args = parsed.value;
      onChange(next);
    }
  }
  function commitEnv(text) {
    setEnvDraft(text);
    const parsed = parseJsonStringMap(text);
    if (parsed.ok) {
      const next = { ...value };
      if (Object.keys(parsed.value).length === 0) delete next.env;
      else next.env = parsed.value;
      onChange(next);
    }
  }
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4("label", { class: "ga-mcp-row", children: [
      /* @__PURE__ */ u4("span", { class: "ga-mcp-row-label", children: "command" }),
      /* @__PURE__ */ u4(
        "input",
        {
          type: "text",
          class: "ga-mcp-input",
          placeholder: "e.g. npx, uvx, /usr/local/bin/my-tool",
          value: value.command ?? "",
          disabled,
          onInput: (e4) => onChange({ ...value, command: e4.currentTarget.value })
        }
      )
    ] }),
    /* @__PURE__ */ u4("label", { class: "ga-mcp-row", children: [
      /* @__PURE__ */ u4("span", { class: "ga-mcp-row-label", children: "args (JSON array)" }),
      /* @__PURE__ */ u4(
        "textarea",
        {
          class: `ga-mcp-textarea${argsParsed.ok ? "" : " ga-mp-key-unknown"}`,
          placeholder: '["-y","@my/mcp-server"]',
          rows: 2,
          value: argsDraft,
          disabled,
          onInput: (e4) => commitArgs(e4.currentTarget.value)
        }
      ),
      !argsParsed.ok ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: argsParsed.error }) : null
    ] }),
    /* @__PURE__ */ u4("label", { class: "ga-mcp-row", children: [
      /* @__PURE__ */ u4("span", { class: "ga-mcp-row-label", children: "env (JSON object)" }),
      /* @__PURE__ */ u4(
        "textarea",
        {
          class: `ga-mcp-textarea${envParsed.ok ? "" : " ga-mp-key-unknown"}`,
          placeholder: '{"FOO":"bar"}',
          rows: 3,
          value: envDraft,
          disabled,
          onInput: (e4) => commitEnv(e4.currentTarget.value)
        }
      ),
      !envParsed.ok ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: envParsed.error }) : null
    ] })
  ] });
}
function McpHttpFields({
  value,
  disabled,
  onChange
}) {
  const headersText = value.headers ? JSON.stringify(value.headers, null, 2) : "";
  const [headersDraft, setHeadersDraft] = h2(headersText);
  y2(() => {
    setHeadersDraft(value.headers ? JSON.stringify(value.headers, null, 2) : "");
  }, [JSON.stringify(value.headers ?? {})]);
  const headersParsed = parseJsonStringMap(headersDraft);
  const urlInvalid = value.url && !/^https?:\/\//.test(value.url);
  function commitHeaders(text) {
    setHeadersDraft(text);
    const parsed = parseJsonStringMap(text);
    if (parsed.ok) {
      const next = { ...value };
      if (Object.keys(parsed.value).length === 0) delete next.headers;
      else next.headers = parsed.value;
      onChange(next);
    }
  }
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4("label", { class: "ga-mcp-row", children: [
      /* @__PURE__ */ u4("span", { class: "ga-mcp-row-label", children: "url" }),
      /* @__PURE__ */ u4(
        "input",
        {
          type: "text",
          class: `ga-mcp-input${urlInvalid ? " ga-mp-key-unknown" : ""}`,
          placeholder: "https://example.com/mcp",
          value: value.url ?? "",
          disabled,
          onInput: (e4) => onChange({ ...value, url: e4.currentTarget.value })
        }
      ),
      urlInvalid ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: "URL must start with http:// or https://" }) : null
    ] }),
    /* @__PURE__ */ u4("label", { class: "ga-mcp-row", children: [
      /* @__PURE__ */ u4("span", { class: "ga-mcp-row-label", children: "headers (JSON object)" }),
      /* @__PURE__ */ u4(
        "textarea",
        {
          class: `ga-mcp-textarea${headersParsed.ok ? "" : " ga-mp-key-unknown"}`,
          placeholder: '{"Authorization":"Bearer \u2026"}',
          rows: 3,
          value: headersDraft,
          disabled,
          onInput: (e4) => commitHeaders(e4.currentTarget.value)
        }
      ),
      !headersParsed.ok ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: headersParsed.error }) : null
    ] })
  ] });
}
function parseJsonStringArray(text) {
  const t4 = text.trim();
  if (t4 === "") return { ok: true, value: [] };
  let parsed;
  try {
    parsed = JSON.parse(t4);
  } catch (e4) {
    return { ok: false, error: `Not valid JSON: ${e4.message}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "Must be a JSON array" };
  for (const v5 of parsed) {
    if (typeof v5 !== "string") return { ok: false, error: "All array entries must be strings" };
  }
  return { ok: true, value: parsed };
}
function parseJsonStringMap(text) {
  const t4 = text.trim();
  if (t4 === "") return { ok: true, value: {} };
  let parsed;
  try {
    parsed = JSON.parse(t4);
  } catch (e4) {
    return { ok: false, error: `Not valid JSON: ${e4.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Must be a JSON object" };
  }
  for (const v5 of Object.values(parsed)) {
    if (typeof v5 !== "string") return { ok: false, error: "All values must be strings" };
  }
  return { ok: true, value: parsed };
}
function SkillsSection({
  value,
  busy,
  onChange
}) {
  const isAll = value === "all";
  const list = isAll ? [] : value;
  const [draft, setDraft] = h2("");
  const trimmed = draft.trim();
  const isInvalid = trimmed !== "" && !SKILL_SLUG_RE.test(trimmed);
  const isDup = trimmed !== "" && list.includes(trimmed);
  const canAdd = !isAll && trimmed !== "" && !isInvalid && !isDup;
  function add() {
    if (!canAdd) return;
    onChange([...list, trimmed]);
    setDraft("");
  }
  function remove(idx) {
    onChange(list.filter((_6, i5) => i5 !== idx));
  }
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4("div", { class: "group-admin-toolbar", children: /* @__PURE__ */ u4("p", { class: "group-admin-help", children: [
      'Container skills mounted into every session in this group. Restart required to take effect \u2014 skill mounts are computed at container spawn. Use "all" to mount every available container skill, or pick specific slugs from ',
      /* @__PURE__ */ u4("code", { children: "container/skills/" }),
      "."
    ] }) }),
    /* @__PURE__ */ u4(Field, { label: "Selection", children: /* @__PURE__ */ u4("div", { class: "group-admin-stack", children: [
      /* @__PURE__ */ u4("label", { class: "group-admin-check", children: [
        /* @__PURE__ */ u4(
          "input",
          {
            type: "radio",
            name: "skills-mode",
            checked: isAll,
            disabled: busy,
            onChange: () => onChange("all")
          }
        ),
        /* @__PURE__ */ u4("span", { children: "All available skills" })
      ] }),
      /* @__PURE__ */ u4("label", { class: "group-admin-check", children: [
        /* @__PURE__ */ u4(
          "input",
          {
            type: "radio",
            name: "skills-mode",
            checked: !isAll,
            disabled: busy,
            onChange: () => onChange([])
          }
        ),
        /* @__PURE__ */ u4("span", { children: "Specific skills only" })
      ] })
    ] }) }),
    !isAll ? /* @__PURE__ */ u4(Field, { label: "Skills", info: "Slug per skill (lowercase a\u2013z, 0\u20139, hyphen). Must match a folder under container/skills/ or a group-local skill.", children: /* @__PURE__ */ u4("div", { class: "group-admin-stack ga-model-params", children: [
      list.length === 0 ? /* @__PURE__ */ u4("p", { class: "group-admin-help", children: "No skills selected." }) : /* @__PURE__ */ u4("ul", { class: "ga-chip-list", children: list.map((s5, i5) => /* @__PURE__ */ u4("li", { class: "ga-chip", children: [
        /* @__PURE__ */ u4("span", { class: "ga-chip-label", children: s5 }),
        /* @__PURE__ */ u4(
          "button",
          {
            type: "button",
            class: "ga-chip-remove",
            "aria-label": `Remove ${s5}`,
            disabled: busy,
            onClick: () => remove(i5),
            children: "\u2715"
          }
        )
      ] }, `${s5}-${i5}`)) }),
      /* @__PURE__ */ u4("div", { class: "ga-mp-actions", children: [
        /* @__PURE__ */ u4(
          "input",
          {
            type: "text",
            class: "ga-chip-input",
            placeholder: "skill slug (e.g. welcome, agent-browser)",
            value: draft,
            disabled: busy,
            onInput: (e4) => setDraft(e4.currentTarget.value),
            onKeyDown: (e4) => {
              if (e4.key === "Enter") {
                e4.preventDefault();
                add();
              }
            }
          }
        ),
        /* @__PURE__ */ u4("button", { type: "button", disabled: busy || !canAdd, onClick: add, children: "+ Add" })
      ] }),
      isInvalid ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: [
        '"',
        trimmed,
        '" must be lowercase a\u2013z, 0\u20139, hyphen.'
      ] }) : isDup ? /* @__PURE__ */ u4("p", { class: "ga-confirm-warn", children: [
        '"',
        trimmed,
        '" is already in the list.'
      ] }) : null
    ] }) }) : null
  ] });
}

// src/panels.ts
function restorePanelState() {
}
function persistPanelState() {
}
function applyPanelClasses() {
  const mobile = MOBILE_MQ.matches;
  isMobile.value = mobile;
  if (mobile) {
    document.body.classList.add("mobile");
  } else {
    document.body.classList.remove("mobile");
    drawerOpen.threads.value = false;
    drawerOpen.files.value = false;
  }
}

// src/router.ts
var router = {
  selectGroup,
  loadThreads,
  openChat,
  clearChat,
  loadTree,
  selectFile,
  notFound: (msg) => {
    console.warn(msg);
  }
};

// src/components/App.tsx
function App() {
  y2(() => {
    const onChange = () => applyPanelClasses();
    MOBILE_MQ.addEventListener("change", onChange);
    const onHashChange = () => {
      if (refs.suppressHashCount > 0) {
        refs.suppressHashCount--;
        return;
      }
      applyHash(router).catch(console.error);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      MOBILE_MQ.removeEventListener("change", onChange);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);
  const threadsOpen = paneOpen.threads.value;
  const filesOpen = paneOpen.files.value;
  y2(() => {
    persistPanelState();
  }, [threadsOpen, filesOpen]);
  const mainCls = (threadsOpen ? "" : " threads-collapsed") + (filesOpen ? "" : " files-collapsed");
  const backdropShown = drawerOpen.threads.value || drawerOpen.files.value;
  const onBackdrop = () => {
    drawerOpen.threads.value = false;
    drawerOpen.files.value = false;
  };
  return /* @__PURE__ */ u4(k, { children: [
    /* @__PURE__ */ u4(Header, {}),
    /* @__PURE__ */ u4("main", { id: "main", class: mainCls.trim(), children: [
      /* @__PURE__ */ u4(ThreadsRail, {}),
      /* @__PURE__ */ u4(ChatMain, {}),
      /* @__PURE__ */ u4(FilesPane, {})
    ] }),
    /* @__PURE__ */ u4("div", { class: "backdrop" + (backdropShown ? " show" : ""), id: "backdrop", onClick: onBackdrop }),
    /* @__PURE__ */ u4(Settings, {}),
    /* @__PURE__ */ u4(ShareLinkModal, {}),
    /* @__PURE__ */ u4(PromptModal, {}),
    /* @__PURE__ */ u4(ConfirmModal, {}),
    /* @__PURE__ */ u4(GroupPickerModal, {}),
    /* @__PURE__ */ u4(GroupAdmin, {}),
    /* @__PURE__ */ u4(CreateGroupModal, {}),
    /* @__PURE__ */ u4(Toast, {})
  ] });
}

// src/index.tsx
function sortGroups(list) {
  return list.slice().sort((a4, b5) => {
    const parseTs = (s5) => {
      if (!s5) return 0;
      const norm = s5.includes("T") ? s5 : s5.replace(" ", "T") + "Z";
      return Date.parse(norm) || 0;
    };
    const ta = parseTs(a4.lastActivityAt);
    const tb = parseTs(b5.lastActivityAt);
    if (tb !== ta) return tb - ta;
    return a4.name.localeCompare(b5.name);
  });
}
function setupViewportFit() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply2 = () => {
    document.documentElement.style.setProperty("--app-height", vv.height + "px");
  };
  apply2();
  vv.addEventListener("resize", apply2);
  vv.addEventListener("scroll", apply2);
  document.addEventListener("focusin", (ev) => {
    const t4 = ev.target;
    if (t4?.id === "chat-input") {
      setTimeout(() => {
        try {
          t4.scrollIntoView({ block: "end", behavior: "smooth" });
        } catch {
        }
      }, 250);
    }
  });
}
var IOS_HINT_DISMISSED_KEY = "nanoclaw:ios-install-hint-dismissed";
function maybeShowIosInstallHint() {
  if (!shouldShowIosInstallHint()) return;
  try {
    if (localStorage.getItem(IOS_HINT_DISMISSED_KEY) === "1") return;
  } catch {
  }
  const el = document.createElement("div");
  el.setAttribute("role", "note");
  el.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:8px;padding:12px 14px;font:13px system-ui;-webkit-font-smoothing:antialiased;box-shadow:0 4px 12px rgba(0,0,0,0.3);display:flex;gap:10px;align-items:flex-start";
  el.innerHTML = '<div style="flex:1">Add to Home Screen to receive notifications when the app is closed. Tap the Share button, then "Add to Home Screen".</div><button type="button" aria-label="Dismiss" style="background:transparent;color:#9ca3af;border:0;font-size:18px;line-height:1;cursor:pointer;padding:0 4px">\xD7</button>';
  const btn = el.querySelector("button");
  if (btn) {
    btn.addEventListener("click", () => {
      try {
        localStorage.setItem(IOS_HINT_DISMISSED_KEY, "1");
      } catch {
      }
      el.remove();
    });
  }
  document.body.appendChild(el);
}
async function init() {
  initNotif();
  initSound();
  initInstall();
  initBadge();
  setupViewportFit();
  installLivenessHandlers();
  restorePanelState();
  applyPanelClasses();
  maybeShowIosInstallHint();
  try {
    const [meRes, groupsRes] = await Promise.all([
      api("api/me"),
      api("api/groups")
    ]);
    n2(() => {
      me.value = meRes.displayName || meRes.userId;
      isElevatedUser.value = meRes.isElevated === true;
      groups.value = sortGroups(groupsRes.groups);
    });
  } catch {
    return;
  }
  if (groups.value.length === 0) {
    const app2 = document.getElementById("app");
    if (app2) app2.innerHTML = '<div style="padding:24px;font:14px system-ui">No accessible groups.</div>';
    return;
  }
  const parsed = parseHash();
  if (parsed && parsed.groupId) chatLoading.value = true;
  applyHash(router).catch((err) => console.error("initial route failed", err));
  const app = document.getElementById("app");
  if (app) D(/* @__PURE__ */ u4(App, {}), app);
  startSyncPoll();
  try {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("settings") === "1") {
      settingsOpen.value = true;
      sp.delete("settings");
      const q5 = sp.toString();
      const url = window.location.pathname + (q5 ? "?" + q5 : "") + window.location.hash;
      window.history.replaceState(null, "", url);
    }
    handleShareTarget();
  } catch {
  }
}
function handleShareTarget() {
  const onShareRoute = window.location.pathname.endsWith("/share");
  const sp = new URLSearchParams(window.location.search);
  const title = sp.get("title") || "";
  const text = sp.get("text") || "";
  const url = sp.get("url") || "";
  if (!title && !text && !url) {
    if (onShareRoute) window.history.replaceState(null, "", "/ui/chat/" + window.location.hash);
    return;
  }
  const combined = [title, text, url].filter(Boolean).join("\n").trim();
  const apply2 = () => {
    const el = document.getElementById("chat-input");
    if (!el) return false;
    el.value = (el.value ? el.value + "\n\n" : "") + combined;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    return true;
  };
  if (!apply2()) {
    let tries = 0;
    const t4 = window.setInterval(() => {
      if (apply2() || ++tries > 50) window.clearInterval(t4);
    }, 100);
  }
  const nextPath = onShareRoute ? "/ui/chat/" : window.location.pathname;
  window.history.replaceState(null, "", nextPath + window.location.hash);
}
init().catch((err) => console.error(err));
//# sourceMappingURL=app.js.map
