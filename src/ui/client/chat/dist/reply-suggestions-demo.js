"use strict";
(() => {
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
    var a4, h4, y5, d5, w5, _6, g5 = t4 && t4.__k || v, m6 = l7.length;
    for (f5 = I(u5, l7, g5, f5, m6), a4 = 0; a4 < m6; a4++) null != (y5 = u5.__k[a4]) && (h4 = -1 === y5.__i ? p : g5[y5.__i] || p, y5.__i = a4, _6 = j(n3, y5, h4, i5, r4, o4, e4, f5, c4, s5), d5 = y5.__e, y5.ref && h4.ref != y5.ref && (h4.ref && V(h4.ref, null, y5), s5.push(y5.ref, y5.__c || d5, y5)), null == w5 && null != d5 && (w5 = d5), 4 & y5.__u || h4.__k === y5.__k ? f5 = A(y5, f5, n3) : "function" == typeof y5.type && void 0 !== _6 ? f5 = _6 : d5 && (f5 = d5.nextSibling), y5.__u &= -7);
    return u5.__e = w5, f5;
  }
  function I(n3, l7, u5, t4, i5) {
    var r4, o4, e4, f5, c4, s5 = u5.length, a4 = s5, h4 = 0;
    for (n3.__k = new Array(i5), r4 = 0; r4 < i5; r4++) null != (o4 = l7[r4]) && "boolean" != typeof o4 && "function" != typeof o4 ? (f5 = r4 + h4, (o4 = n3.__k[r4] = "string" == typeof o4 || "number" == typeof o4 || "bigint" == typeof o4 || o4.constructor == String ? m(null, o4, null, null, null) : d(o4) ? m(k, { children: o4 }, null, null, null) : void 0 === o4.constructor && o4.__b > 0 ? m(o4.type, o4.props, o4.key, o4.ref ? o4.ref : null, o4.__v) : o4).__ = n3, o4.__b = n3.__b + 1, e4 = null, -1 !== (c4 = o4.__i = L(o4, u5, f5, a4)) && (a4--, (e4 = u5[c4]) && (e4.__u |= 2)), null == e4 || null === e4.__v ? (-1 == c4 && h4--, "function" != typeof o4.type && (o4.__u |= 4)) : c4 != f5 && (c4 == f5 - 1 ? h4-- : c4 == f5 + 1 ? h4++ : (c4 > f5 ? h4-- : h4++, o4.__u |= 4))) : n3.__k[r4] = null;
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
    var a4, h4, p4, v5, y5, g5, m6, b4, C3, S3, M3, P3, I3, A5, H2, L3, T4, F3 = u5.type;
    if (void 0 !== u5.constructor) return null;
    128 & t4.__u && (c4 = !!(32 & t4.__u), o4 = [f5 = u5.__e = t4.__e]), (a4 = l.__b) && a4(u5);
    n: if ("function" == typeof F3) try {
      if (b4 = u5.props, C3 = "prototype" in F3 && F3.prototype.render, S3 = (a4 = F3.contextType) && i5[a4.__c], M3 = a4 ? S3 ? S3.props.value : a4.__ : i5, t4.__c ? m6 = (h4 = u5.__c = t4.__c).__ = h4.__E : (C3 ? u5.__c = h4 = new F3(b4, M3) : (u5.__c = h4 = new x(b4, M3), h4.constructor = F3, h4.render = B), S3 && S3.sub(h4), h4.props = b4, h4.state || (h4.state = {}), h4.context = M3, h4.__n = i5, p4 = h4.__d = true, h4.__h = [], h4._sb = []), C3 && null == h4.__s && (h4.__s = h4.state), C3 && null != F3.getDerivedStateFromProps && (h4.__s == h4.state && (h4.__s = w({}, h4.__s)), w(h4.__s, F3.getDerivedStateFromProps(b4, h4.__s))), v5 = h4.props, y5 = h4.state, h4.__v = u5, p4) C3 && null == F3.getDerivedStateFromProps && null != h4.componentWillMount && h4.componentWillMount(), C3 && null != h4.componentDidMount && h4.__h.push(h4.componentDidMount);
      else {
        if (C3 && null == F3.getDerivedStateFromProps && b4 !== v5 && null != h4.componentWillReceiveProps && h4.componentWillReceiveProps(b4, M3), !h4.__e && (null != h4.shouldComponentUpdate && false === h4.shouldComponentUpdate(b4, h4.__s, M3) || u5.__v == t4.__v)) {
          for (u5.__v != t4.__v && (h4.props = b4, h4.state = h4.__s, h4.__d = false), u5.__e = t4.__e, u5.__k = t4.__k, u5.__k.some(function(n4) {
            n4 && (n4.__ = u5);
          }), P3 = 0; P3 < h4._sb.length; P3++) h4.__h.push(h4._sb[P3]);
          h4._sb = [], h4.__h.length && e4.push(h4);
          break n;
        }
        null != h4.componentWillUpdate && h4.componentWillUpdate(b4, h4.__s, M3), C3 && null != h4.componentDidUpdate && h4.__h.push(function() {
          h4.componentDidUpdate(v5, y5, g5);
        });
      }
      if (h4.context = M3, h4.props = b4, h4.__P = n3, h4.__e = false, I3 = l.__r, A5 = 0, C3) {
        for (h4.state = h4.__s, h4.__d = false, I3 && I3(u5), a4 = h4.render(h4.props, h4.state, h4.context), H2 = 0; H2 < h4._sb.length; H2++) h4.__h.push(h4._sb[H2]);
        h4._sb = [];
      } else do {
        h4.__d = false, I3 && I3(u5), a4 = h4.render(h4.props, h4.state, h4.context), h4.state = h4.__s;
      } while (h4.__d && ++A5 < 25);
      h4.state = h4.__s, null != h4.getChildContext && (i5 = w(w({}, i5), h4.getChildContext())), C3 && !p4 && null != h4.getSnapshotBeforeUpdate && (g5 = h4.getSnapshotBeforeUpdate(v5, y5)), f5 = $(n3, d(L3 = null != a4 && a4.type === k && null == a4.key ? a4.props.children : a4) ? L3 : [L3], u5, t4, i5, r4, o4, e4, f5, c4, s5), h4.base = u5.__e, u5.__u &= -161, h4.__h.length && e4.push(h4), m6 && (h4.__E = h4.__ = null);
    } catch (n4) {
      if (u5.__v = null, c4 || null != o4) if (n4.then) {
        for (u5.__u |= c4 ? 160 : 128; f5 && 8 == f5.nodeType && f5.nextSibling; ) f5 = f5.nextSibling;
        o4[o4.indexOf(f5)] = null, u5.__e = f5;
      } else for (T4 = o4.length; T4--; ) _(o4[T4]);
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
    var a4, h4, v5, y5, w5, g5, m6, b4 = i5.props, k4 = t4.props, x5 = t4.type;
    if ("svg" == x5 ? o4 = "http://www.w3.org/2000/svg" : "math" == x5 ? o4 = "http://www.w3.org/1998/Math/MathML" : o4 || (o4 = "http://www.w3.org/1999/xhtml"), null != e4) {
      for (a4 = 0; a4 < e4.length; a4++) if ((w5 = e4[a4]) && "setAttribute" in w5 == !!x5 && (x5 ? w5.localName == x5 : 3 == w5.nodeType)) {
        u5 = w5, e4[a4] = null;
        break;
      }
    }
    if (null == u5) {
      if (null == x5) return document.createTextNode(k4);
      u5 = document.createElementNS(o4, x5, k4.is && k4), c4 && (l.__m && l.__m(t4, e4), c4 = false), e4 = null;
    }
    if (null === x5) b4 === k4 || c4 && u5.data === k4 || (u5.data = k4);
    else {
      if (e4 = e4 && n.call(u5.childNodes), b4 = i5.props || p, !c4 && null != e4) for (b4 = {}, a4 = 0; a4 < u5.attributes.length; a4++) b4[(w5 = u5.attributes[a4]).name] = w5.value;
      for (a4 in b4) if (w5 = b4[a4], "children" == a4) ;
      else if ("dangerouslySetInnerHTML" == a4) v5 = w5;
      else if (!(a4 in k4)) {
        if ("value" == a4 && "defaultValue" in k4 || "checked" == a4 && "defaultChecked" in k4) continue;
        F(u5, a4, null, w5, o4);
      }
      for (a4 in k4) w5 = k4[a4], "children" == a4 ? y5 = w5 : "dangerouslySetInnerHTML" == a4 ? h4 = w5 : "value" == a4 ? g5 = w5 : "checked" == a4 ? m6 = w5 : c4 && "function" != typeof w5 || b4[a4] === w5 || F(u5, a4, w5, b4[a4], o4);
      if (h4) c4 || v5 && (h4.__html === v5.__html || h4.__html === u5.innerHTML) || (u5.innerHTML = h4.__html), t4.__k = [];
      else if (v5 && (u5.innerHTML = ""), $(u5, d(y5) ? y5 : [y5], t4, i5, r4, "foreignObject" == x5 ? "http://www.w3.org/1999/xhtml" : o4, e4, f5, e4 ? e4[0] : i5.__k && C(i5, 0), c4, s5), null != e4) for (a4 = e4.length; a4--; ) _(e4[a4]);
      c4 || (a4 = "value", "progress" == x5 && null == g5 ? u5.removeAttribute("value") : void 0 !== g5 && (g5 !== u5[a4] || "progress" == x5 && !g5 || "option" == x5 && g5 !== b4[a4]) && F(u5, a4, g5, b4[a4], o4), a4 = "checked", void 0 !== m6 && m6 !== u5[a4] && F(u5, a4, m6, b4[a4], o4));
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
  function _2(n3, u5) {
    var i5 = d2(t2++, 4);
    !c2.__s && C2(i5.__H, u5) && (i5.__ = n3, i5.i = u5, r2.__h.push(i5));
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
      while (void 0 !== h2) {
        var n3 = h2;
        h2 = void 0;
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
  var h2 = void 0;
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
  function y2(i5, t4) {
    return new l3(i5, t4);
  }
  function w3(i5) {
    for (var t4 = i5.s; void 0 !== t4; t4 = t4.n) if (t4.S.i !== t4.i || !t4.S.h() || t4.S.i !== t4.i) return true;
    return false;
  }
  function _3(i5) {
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
  function p2(i5, t4) {
    l3.call(this, void 0);
    this.x = i5;
    this.s = void 0;
    this.g = d3 - 1;
    this.f = 4;
    this.W = null == t4 ? void 0 : t4.watched;
    this.Z = null == t4 ? void 0 : t4.unwatched;
    this.name = null == t4 ? void 0 : t4.name;
  }
  p2.prototype = new l3();
  p2.prototype.h = function() {
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
      _3(this);
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
  p2.prototype.S = function(i5) {
    if (void 0 === this.t) {
      this.f |= 36;
      for (var t4 = this.s; void 0 !== t4; t4 = t4.n) t4.S.S(t4);
    }
    l3.prototype.S.call(this, i5);
  };
  p2.prototype.U = function(i5) {
    if (void 0 !== this.t) {
      l3.prototype.U.call(this, i5);
      if (void 0 === this.t) {
        this.f &= -33;
        for (var t4 = this.s; void 0 !== t4; t4 = t4.n) t4.S.U(t4);
      }
    }
  };
  p2.prototype.N = function() {
    if (!(2 & this.f)) {
      this.f |= 6;
      for (var i5 = this.t; void 0 !== i5; i5 = i5.x) i5.t.N();
    }
  };
  Object.defineProperty(p2.prototype, "value", { get: function() {
    if (1 & this.f) throw new Error("Cycle detected");
    var i5 = a3(this);
    this.h();
    if (void 0 !== i5) i5.i = this.i;
    if (16 & this.f) throw this.v;
    return this.v;
  } });
  function g2(i5, t4) {
    return new p2(i5, t4);
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
    _3(this);
    s3++;
    var i5 = r3;
    r3 = this;
    return x2.bind(this, i5);
  };
  E.prototype.N = function() {
    if (!(2 & this.f)) {
      this.f |= 2;
      this.u = h2;
      h2 = this;
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
  var h3;
  var l4;
  var p3 = [];
  j3(function() {
    s4 = this.N;
  })();
  function _4(i5, r4) {
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
  _4("__b", function(i5, n3) {
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
  _4("__r", function(i5, n3) {
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
    h3 = t4;
    m4(r4);
    i5(n3);
  });
  _4("__e", function(i5, n3, r4, t4) {
    m4();
    h3 = void 0;
    i5(n3, r4, t4);
  });
  _4("diffed", function(i5, n3) {
    m4();
    h3 = void 0;
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
    var f5 = n3 in i5 && void 0 === i5.ownerSVGElement, o4 = y2(r4);
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
  _4("unmount", function(i5, n3) {
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
  _4("__h", function(i5, n3, r4, t4) {
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
      return y2(i5);
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
      while (i5 = p3.shift()) s4.call(i5);
    });
  }
  function A3() {
    if (1 === p3.push(this)) (l.requestAnimationFrame || k3)(x3);
  }

  // ../../shared/validation.ts
  var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  var text = (value) => typeof value === "string";
  var id = (value) => text(value) && value.length > 0;
  var bool = (value) => typeof value === "boolean";
  var number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  var integer = (value) => number(value) && Number.isSafeInteger(value);
  var position = (value) => integer(value) && Number(value) > 0;
  var optional = (check) => (value) => value === void 0 || check(value);
  var nullable = (check) => (value) => value === null || check(value);
  var array = (check) => (value) => Array.isArray(value) && value.every(check);
  var oneOf = (...values) => (value) => typeof value === "string" && values.includes(value);
  var shape = (fields) => (value) => object(value) && Object.entries(fields).every(([key, check]) => check(value[key]));

  // ../../shared/read-state.ts
  var cursor = shape({ sessionId: id, key: (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value) });
  function isReadCursor(value) {
    return cursor(value);
  }

  // ../../../time.ts
  function isEpochMs(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 864e13;
  }

  // ../../shared/time.ts
  var UI_TIMESTAMP_PROTOCOL_VERSION = 16;
  var UI_PROTOCOL_HEADER = "X-NanoClaw-UI-Protocol";

  // ../../shared/oauth-app.ts
  function isOAuthScope(value) {
    return typeof value === "string" && value.length > 0 && [...value].every((character) => character >= "!" && character <= "~" && character !== '"' && character !== "\\");
  }

  // ../../shared/access-authentication.ts
  var AccessAuthenticationError = class extends Error {
  };
  var HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
  var PARAMETER = /^[A-Za-z0-9._~-]{1,128}$/;
  function validHeader(value) {
    return typeof value === "string" && HEADER.test(value) && !["proxy-authorization", "x-agentvault-binding"].includes(value.toLowerCase());
  }
  function parseAccessAuthentication(value) {
    if (value === void 0) return void 0;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AccessAuthenticationError("Authentication hints must describe a mechanism, never credential values.");
    const hint = value;
    if (Object.keys(hint).some(
      (key) => !["type", "app_id", "header", "prefix", "headers", "location", "parameter"].includes(key)
    ) || !["mcp_oauth", "oauth_app", "bearer", "api-key", "basic", "custom"].includes(String(hint.type)))
      throw new AccessAuthenticationError(
        "Choose a supported sign-in method. Never include passwords or access keys in this request."
      );
    const type = hint.type;
    const oauth = type === "mcp_oauth" || type === "oauth_app";
    if (hint.location !== void 0 && (type !== "api-key" || hint.location !== "header" && hint.location !== "query"))
      throw new AccessAuthenticationError("API-key placement must be header or query.");
    const query = type === "api-key" && hint.location === "query";
    if (hint.app_id !== void 0 && (!oauth || typeof hint.app_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(hint.app_id)))
      throw new AccessAuthenticationError(
        "An OAuth app suggestion must be a configured app identifier, not a credential or client secret."
      );
    if (hint.header !== void 0 && (type !== "api-key" || query))
      throw new AccessAuthenticationError("A header name is only valid for API-key header placement.");
    if (type === "api-key" && !query && !validHeader(hint.header))
      throw new AccessAuthenticationError("API-key authentication requires a valid header name.");
    if (hint.parameter !== void 0 && !query || query && (typeof hint.parameter !== "string" || !PARAMETER.test(hint.parameter)))
      throw new AccessAuthenticationError("Query API keys require a public parameter name, never a value.");
    if (hint.prefix !== void 0 && (type !== "api-key" || query || typeof hint.prefix !== "string" || hint.prefix.length > 128 || [...hint.prefix].some((char) => char < " " || char > "~")))
      throw new AccessAuthenticationError("Provide only a public API-key header prefix without control characters.");
    if (hint.headers !== void 0 && type !== "custom" || type === "custom" && (!Array.isArray(hint.headers) || !hint.headers.length || hint.headers.length > 16 || !hint.headers.every(validHeader) || new Set(hint.headers.map((header) => header.toLowerCase())).size !== hint.headers.length))
      throw new AccessAuthenticationError(
        "Custom authentication requires distinct header names only, never header values."
      );
    return {
      type,
      ...hint.app_id === void 0 ? {} : { app_id: hint.app_id },
      ...hint.header === void 0 ? {} : { header: hint.header },
      ...hint.prefix === void 0 ? {} : { prefix: hint.prefix },
      ...hint.location === void 0 ? {} : { location: hint.location },
      ...hint.parameter === void 0 ? {} : { parameter: hint.parameter },
      ...hint.headers === void 0 ? {} : { headers: [...hint.headers] }
    };
  }

  // ../../shared/connection-input.ts
  var ConnectionInputError = class extends Error {
    constructor(message2, status = 400) {
      super(message2);
      this.status = status;
    }
  };
  function objectBody(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ConnectionInputError("Provide a JSON object");
    return value;
  }
  function accessRequestInput(raw) {
    const body = objectBody(raw);
    if (Object.keys(body).some((key) => !["resource_url", "reason", "scopes", "mcp_server", "authentication"].includes(key)))
      throw new ConnectionInputError(
        "Access requests accept only resource_url, reason, optional scopes and an optional mcp_server name. Never supply secrets."
      );
    const url = typeof body.resource_url === "string" ? URL.parse(body.resource_url) : null;
    let authentication;
    try {
      authentication = parseAccessAuthentication(body.authentication);
    } catch (error) {
      if (!(error instanceof AccessAuthenticationError)) throw error;
      throw new ConnectionInputError(error.message);
    }
    if (body.mcp_server !== void 0 && (typeof body.mcp_server !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(body.mcp_server)))
      throw new ConnectionInputError("Select an existing named MCP server.");
    if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href.length > 2048 || [...String(body.resource_url)].some((char) => char.charCodeAt(0) <= 32 || char === "*"))
      throw new ConnectionInputError(
        "Provide an exact HTTPS destination without credentials, query, fragment or wildcard."
      );
    if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1e3 || [...body.reason].some((char) => char.charCodeAt(0) < 32 && !["	", "\n", "\r"].includes(char)))
      throw new ConnectionInputError("Explain the access needed in at most 1000 characters; do not include credentials.");
    if (body.scopes !== void 0 && (!Array.isArray(body.scopes) || body.scopes.length > 64 || !body.scopes.every((scope) => isOAuthScope(scope) && scope.length <= 2048)))
      throw new ConnectionInputError("Provide valid scope suggestions, never tokens.");
    if (Array.isArray(body.scopes) && body.scopes.length && authentication && !["mcp_oauth", "oauth_app", "bearer"].includes(authentication.type))
      throw new ConnectionInputError("OAuth scope suggestions require an OAuth or bearer authentication request.");
    return {
      resource_url: url.href,
      reason: body.reason.trim(),
      ...authentication ? { authentication } : {},
      ...body.mcp_server === void 0 ? {} : { mcp_server: body.mcp_server },
      ...body.scopes === void 0 ? {} : { scopes: [...new Set(body.scopes)].sort() }
    };
  }

  // ../../shared/suggested-responses.ts
  var MAX_SUGGESTED_RESPONSES = 6;
  var MAX_SUGGESTED_RESPONSE_LENGTH = 240;
  function isSuggestedResponses(value) {
    return Array.isArray(value) && value.length > 0 && value.length <= MAX_SUGGESTED_RESPONSES && value.every((text2) => typeof text2 === "string" && !!text2.trim() && text2.length <= MAX_SUGGESTED_RESPONSE_LENGTH) && new Set(value).size === value.length;
  }

  // ../../shared/conversation-protocol.ts
  var CONVERSATION_PROTOCOL_VERSION = UI_TIMESTAMP_PROTOCOL_VERSION + 1;
  var strings = array(id);
  var usageFields = {
    cost_usd: number,
    input_tokens: number,
    output_tokens: number,
    cache_read_tokens: number,
    cache_write_tokens: number,
    model: text,
    reasoning_tokens: optional(number),
    num_turns: optional(number),
    context_window: optional(number),
    max_output_tokens: optional(number),
    context_tokens: optional(number),
    duration_ms: optional(number),
    duration_api_ms: optional(number)
  };
  var reportedUsage = shape(
    Object.fromEntries(Object.entries(usageFields).map(([key, check]) => [key, optional(check)]))
  );
  var message = shape({
    id,
    direction: oneOf("in", "out", "event"),
    timestamp: isEpochMs,
    text,
    suggestedResponses: optional(isSuggestedResponses),
    turnId: optional(id),
    timelinePosition: optional(integer),
    inputState: optional(
      shape({
        messageId: id,
        status: oneOf("queued", "steering", "applied", "processing", "cancelled"),
        turnId: optional(text),
        timelinePosition: optional(integer),
        queuedForNextTurn: optional(bool),
        reason: optional(oneOf("turn_finished", "different_conversation", "unsupported"))
      })
    ),
    canEditPending: optional(bool),
    author: optional(shape({ userId: id, displayName: text })),
    deliveryOrigin: optional(oneOf("send_message", "send_file", "response")),
    systemGenerated: optional(bool),
    suggestedAction: optional(oneOf("continue", "retry", "report")),
    files: optional(
      array(
        shape({
          filename: text,
          size: number,
          path: optional(text),
          url: optional(text),
          contentType: optional(text)
        })
      )
    ),
    card: optional(
      shape({
        title: text,
        description: text,
        children: array(text),
        actions: array(shape({ label: text, url: text, style: optional(oneOf("primary", "danger", "default")) }))
      })
    ),
    reactions: optional(array(shape({ emoji: text, ts: isEpochMs }))),
    event: optional(
      shape({
        kind: oneOf("task-run"),
        summary: text,
        taskId: optional(text),
        recurrence: optional(nullable(text)),
        status: optional(oneOf("running", "ready", "skipped", "failed", "timed_out", "completed")),
        triggerSource: optional(oneOf("scheduled", "manual")),
        error: optional(nullable(text)),
        autoPaused: optional(bool)
      })
    )
  });
  var activityLine = shape({ ordinal: integer, ts: isEpochMs, text, timelinePosition: position });
  var turnFields = {
    id,
    phase: oneOf("running", "stopping", "settling", "settled"),
    outcome: oneOf("pending", "replied", "warning", "silent", "stopped", "failed", "unknown", "interrupted"),
    startedAt: nullable(isEpochMs),
    requestedAt: optional(nullable(isEpochMs)),
    endedAt: nullable(isEpochMs),
    inputIds: strings,
    outputIds: strings,
    usage: array(shape({ id, value: reportedUsage })),
    metadata: shape({
      status: oneOf("provisional", "partial", "final", "unavailable"),
      model: nullable(text),
      durationMs: nullable(number)
    })
  };
  var turn = shape({ ...turnFields, activity: array(activityLine) });
  var consentContext = {
    id,
    agentGroupId: nullable(text),
    agentGroupName: nullable(text),
    createdAt: isEpochMs,
    origin: optional(nullable(shape({ agentGroupId: id, threadId: id, channelType: id, messagingGroupId: id }))),
    decision: optional(nullable(text)),
    respondedBy: optional(nullable(shape({ userId: id, displayName: text }))),
    responseMessage: optional(nullable(text)),
    outcomeMessage: optional(nullable(text)),
    resolvedAt: optional(nullable(isEpochMs))
  };
  var approval = shape({
    ...consentContext,
    kind: oneOf("confirmation"),
    action: text,
    title: text,
    details: nullable(text),
    packages: nullable(shape({ apt: array(text), npm: array(text), pip: array(text) })),
    options: array(shape({ label: text, selectedLabel: text, value: text })),
    supportsResponseMessage: bool,
    status: oneOf("pending", "applying", "approved", "rejected", "failed", "cancelled", "expired")
  });
  var requirements = (value) => {
    try {
      accessRequestInput(value);
      return true;
    } catch (error) {
      if (error instanceof ConnectionInputError) return false;
      throw error;
    }
  };
  var account = shape({
    ...consentContext,
    kind: oneOf("account_setup", "access_grant"),
    requirements,
    revision: integer,
    retryable: bool,
    expiresAt: nullable(isEpochMs),
    agentGroupId: id,
    agentGroupName: text,
    status: oneOf("pending", "applying", "completed", "rejected", "cancelled", "expired", "failed"),
    outcomeMessage: nullable(text),
    resolvedAt: nullable(isEpochMs)
  });
  var interaction = (value) => approval(value) || account(value);
  var tracePlacement = shape({ turnId: id, ordinals: array(integer), ownsTurn: bool });
  var timelineRow = (v5) => shape({ kind: oneOf("message"), messageId: id, trace: optional(tracePlacement), statsTurnId: optional(id) })(v5) || shape({ kind: oneOf("interaction"), interactionId: id, trace: optional(tracePlacement) })(v5) || shape({ kind: oneOf("turn"), turnId: id, afterId: nullable(id), trace: tracePlacement, status: bool })(v5);
  var connection = shape({ connected: bool, activeTurnId: nullable(id) });
  var capabilities = shape({
    canSend: bool,
    stop: bool,
    stopTool: optional(bool),
    steer: bool,
    editInput: bool,
    cancelInput: bool
  });
  var conversation = shape({
    readCursor: optional(isReadCursor),
    threadId: id,
    messages: array(message),
    turns: array(turn),
    interactions: array(interaction),
    timeline: array(timelineRow),
    connection,
    capabilities
  });

  // src/state.ts
  var groups = y2([]);
  var agentActivity = y2([]);
  var groupId = y2(null);
  var isAdmin = g2(() => {
    const id2 = groupId.value;
    if (!id2) return false;
    const g5 = groups.value.find((x5) => x5.id === id2);
    return !!(g5 && g5.isAdmin);
  });
  if (typeof document !== "undefined") {
    j3(() => {
      document.body.classList.toggle("is-admin", isAdmin.value);
    });
  }
  var isElevatedUser = y2(false);
  var treePath = y2("");
  var filePath = y2(null);
  var treeEntries = y2([]);
  var treeError = y2("");
  var fileSearchOpen = y2(false);
  var fileSearchRoot = y2("");
  var fileSearchQuery = y2("");
  var fileSearchResults = y2(null);
  var fileSearchLoading = y2(false);
  var fileSearchError = y2("");
  var fileSearchTruncated = y2(false);
  var fileSearchSelectedPath = y2(null);
  var mediaCurrentTime = y2(0);
  var threads = y2([]);
  var threadId = y2(null);
  var channelType = y2("web");
  var messagingGroupId = y2(null);
  var canSend = y2(true);
  var voiceInput = y2({
    backend: "disabled",
    ready: false,
    reason: "Live voice input is not configured."
  });
  var chatMessages = y2([]);
  var chatStatus = y2("");
  var chatLoading = y2(false);
  var chatReady = y2(false);
  var chatReloadRequired = y2(false);
  var activeTurn = y2(null);
  var turnConnected = y2(false);
  var stopRequest = y2(null);
  var pendingWebSends = y2([]);
  var pending = y2([]);
  var searchQuery = y2("");
  var searchResults = y2(null);
  var searchLoading = y2(false);
  var searchError = y2("");
  var searchOpen = y2(false);
  var highlightMessageId = y2(null);
  var revealedMobileMessageActionsId = y2(null);
  var scrollToBottomTick = y2(0);
  var paneOpen = {
    threads: y2(false),
    files: y2(false)
  };
  var drawerOpen = {
    threads: y2(false),
    files: y2(false)
  };
  var isMobile = y2(false);
  var uploadItems = y2([]);
  var me = y2("");
  var currentUserId = y2("");
  var notifMutedSig = y2(false);
  var progressSoundMutedSig = y2(false);
  var completionSoundMutedSig = y2(false);
  var userMenuOpen = y2(false);
  var settingsOpen = y2(false);
  var groupAdminOpen = y2(false);
  var groupAdminTabRequest = y2(null);
  var credentialsOpen = y2(false);
  var groupPickerOpen = y2(false);
  var groupPickerMode = y2("all");
  var shareModalRequest = y2(null);
  var taskPanelRequest = y2(null);
  var toastMessage = y2(null);
  var previewBlock = y2(null);
  var nowTick = y2(Date.now());
  var pinnedContext = y2([]);
  var pendingApprovals = y2([]);
  var respondingInteractionIds = y2(/* @__PURE__ */ new Set());
  var UPLOAD_MAX_FILE_SIZE = 25 * 1024 * 1024;
  var UPLOAD_MAX_TOTAL_SIZE = 50 * 1024 * 1024;
  var MOBILE_MQ = window.matchMedia("(max-width: 720px)");

  // src/api.ts
  var UiProtocolError = class extends Error {
    constructor() {
      super("The app and server versions do not match. Reload this page to update the app.");
      this.name = "UiProtocolError";
    }
  };
  var UI_RELOAD_EVENT = "nanoclaw:ui-reload-required";
  function isOwnedApi(url) {
    if (/^https?:\/\//.test(url)) {
      const parsed = new URL(url);
      return typeof window !== "undefined" && parsed.origin === window.location?.origin && /^\/ui\/(?:chat|settings)\/api(?:\/|$)/.test(parsed.pathname);
    }
    return /^(?:\/ui\/(?:chat|settings)\/)?api(?:\/|$)/.test(url);
  }
  async function protocolFetch(url, opts) {
    const owned = isOwnedApi(url);
    const headers = new Headers(opts?.headers);
    if (owned) headers.set(UI_PROTOCOL_HEADER, String(UI_TIMESTAMP_PROTOCOL_VERSION));
    const response2 = await fetch(url, { credentials: "same-origin", ...opts, headers });
    if (owned && response2.status !== 401 && (response2.ok || response2.headers.get(UI_PROTOCOL_HEADER) !== null) && response2.headers.get(UI_PROTOCOL_HEADER) !== String(UI_TIMESTAMP_PROTOCOL_VERSION)) {
      const error = new UiProtocolError();
      if (typeof window !== "undefined") window.dispatchEvent(new Event(UI_RELOAD_EVENT));
      throw error;
    }
    return response2;
  }

  // src/stop-tool.ts
  var requests = y2({});

  // src/pending-edit.ts
  var pendingEditorSessions = y2(/* @__PURE__ */ new Map());
  var composerSendInFlight = y2(false);
  function currentPendingEditor() {
    return [...pendingEditorSessions.value].find(
      ([, session]) => session.open && isCurrentConversation(session.gid, session.thread)
    );
  }
  function isCurrentConversation(gid, thread) {
    return groupId.value === gid && threadId.value === thread.threadId && channelType.value === (thread.channelType || "web") && messagingGroupId.value === (thread.messagingGroupId ?? null);
  }

  // src/pending-cancel.ts
  var pendingCancellations = y2(/* @__PURE__ */ new Map());

  // src/appearance.ts
  var DEFAULT_APPEARANCE = {
    version: 3,
    theme: "default",
    mode: "system",
    density: "compact",
    showTechnicalStatus: false
  };

  // src/appearance-state.ts
  var appearance = y2({
    preferences: { ...DEFAULT_APPEARANCE },
    resolvedMode: "light",
    error: null
  });

  // src/activity-trace-state.ts
  var traceOpen = y2(/* @__PURE__ */ new Map());
  var metricsOpen = y2(/* @__PURE__ */ new Map());

  // src/conversation-state.ts
  var conversationState = y2(null);
  var completedResponse = y2(null);
  var chatTranscript = y2([]);

  // src/reply-suggestions.ts
  function inlineReplyDraft(href) {
    if (!/^reply:/i.test(href)) return null;
    try {
      const text2 = decodeURIComponent(href.slice("reply:".length));
      const control = [...text2].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 && code !== 10 || code === 127;
      });
      return text2.trim() && text2.length <= MAX_SUGGESTED_RESPONSE_LENGTH && !control ? text2 : null;
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
  }
  function suggestionsActive(messageId, messages2, turns, sending) {
    if (sending || turns.some((turn4) => turn4.phase !== "settled")) return false;
    const index = messages2.findIndex((message3) => message3.id === messageId);
    const message2 = messages2[index];
    if (!message2 || message2.direction !== "out" || message2.deliveryOrigin !== "response") return false;
    const turn3 = turns.find((candidate) => candidate.id === message2.turnId);
    return turn3?.phase === "settled" && turn3.outcome === "replied" && !messages2.slice(index + 1).some((next) => next.direction !== "event" && next.inputState?.status !== "cancelled");
  }
  function fillSuggestedDraft(input, text2) {
    if (!input || input.disabled || input.readOnly)
      return { filled: false, error: "The composer is unavailable. Your draft has been kept." };
    if (input.value.length)
      return { filled: false, error: "Your draft has been kept. Clear it before choosing a suggested reply." };
    input.value = text2;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    input.setSelectionRange(text2.length, text2.length);
    return { filled: true };
  }

  // src/recorder.ts
  var isRecording = y2(false);
  var recordingDuration = y2(0);

  // ../../shared/voice.ts
  var VOICE_SAMPLE_RATE = 16e3;
  var VOICE_BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2;
  var VOICE_MAX_FRAME_BYTES = 32768;
  var VOICE_MAX_BUFFER_BYTES = VOICE_BYTES_PER_SECOND * 4;
  var VOICE_UPLOAD_BURST_BYTES = VOICE_MAX_BUFFER_BYTES - VOICE_MAX_FRAME_BYTES;

  // src/voice.ts
  function replaceSegment(segments, next) {
    const index = segments.findIndex((segment) => segment.id === next.id);
    if (index < 0) return [...segments, next];
    const previous = segments[index];
    if (previous.sequence >= next.sequence || previous.final && !next.final) return segments;
    return segments.map((segment, i5) => i5 === index ? next : segment);
  }
  function insertVoiceText(prefix, text2, suffix) {
    if (!text2) return prefix + suffix;
    const before = prefix && !/[\s([{]$/.test(prefix) && !/^[,.;:!?%)\]}]/.test(text2) ? " " : "";
    const after = suffix && !/^[\s,.;:!?%)\]}]/.test(suffix) && !/[([{]$/.test(text2) ? " " : "";
    return prefix + before + text2 + after + suffix;
  }
  var initialState = () => ({
    phase: "idle",
    target: null,
    elapsedMs: 0,
    error: "",
    sending: false,
    connected: false
  });
  var VoiceController = class {
    constructor(deps) {
      this.deps = deps;
    }
    state = y2(initialState());
    target = null;
    generation = 0;
    socket = null;
    capture = null;
    captureAbort = null;
    timeout = null;
    timer = null;
    drainTimer = null;
    audioQueue = [];
    queuedBytes = 0;
    uploadAllowance = VOICE_UPLOAD_BURST_BYTES;
    allowanceAt = 0;
    captureFlushed = false;
    startedAt = 0;
    diagnostics = null;
    segments = [];
    draft = "";
    selection = { start: 0, end: 0 };
    intent = "stop";
    finishSent = false;
    update(patch) {
      this.state.value = { ...this.state.value, ...patch };
    }
    current(generation) {
      return this.generation === generation && !!this.target?.isCurrent();
    }
    start(target, start = target.getText().length, end = start) {
      if (this.state.value.sending || !["idle", "error"].includes(this.state.value.phase)) return;
      this.detach();
      this.target = target;
      this.update({ target: target.key });
      this.connect(start, end);
    }
    connect(start, end) {
      const target = this.target;
      const draft2 = target.getText();
      this.draft = draft2;
      start = Math.max(0, Math.min(start, draft2.length));
      end = Math.max(start, Math.min(end, draft2.length));
      this.selection = { start, end };
      this.segments = [];
      this.intent = "stop";
      this.finishSent = false;
      this.startedAt = Date.now();
      this.diagnostics = { attemptId: this.deps.attemptId(), peakQueuedBytes: 0 };
      this.captureFlushed = false;
      this.uploadAllowance = VOICE_UPLOAD_BURST_BYTES;
      const generation = ++this.generation;
      this.update({ phase: "connecting", error: "" });
      void this.acquireCapture(generation);
      if (!this.current(generation)) return;
      const base = this.deps.origin().replace(/^http/, "ws");
      const params = new URLSearchParams();
      params.set("attempt", this.diagnostics.attemptId);
      if (target.channelType && target.channelType !== "web") {
        params.set("channel", target.channelType);
        if (target.messagingGroupId) params.set("mg", target.messagingGroupId);
      }
      let socket;
      try {
        socket = this.deps.socket(
          `${base}/ui/chat/api/groups/${encodeURIComponent(target.groupId)}/chat/${encodeURIComponent(target.threadId)}/voice/stream?${params}`
        );
      } catch (error) {
        this.fail(error instanceof Error ? error.message : "Could not connect to voice input.", "connection");
        return;
      }
      this.socket = socket;
      this.timeout = setTimeout(() => {
        if (this.current(generation)) this.fail("Voice input did not become ready. Try again.", "connection");
      }, 15e3);
      socket.onmessage = (event) => this.handleMessage(event.data, generation);
      socket.onerror = () => {
        if (this.current(generation)) this.fail("Voice connection failed. Current text has been kept.", "connection");
      };
      socket.onclose = () => {
        if (this.current(generation))
          this.fail("Voice connection closed before finalization. Current text has been kept.", "connection");
      };
    }
    async acquireCapture(generation) {
      const abort = new AbortController();
      this.captureAbort = abort;
      try {
        const capture = await this.deps.capture(
          (chunk) => this.enqueueAudio(chunk, generation),
          (message2) => {
            if (this.current(generation)) this.fail(message2, "capture");
          },
          abort.signal
        );
        if (!this.current(generation)) {
          capture.cancel();
          return;
        }
        this.capture = capture;
        if (this.diagnostics) this.diagnostics.captureReadyMs = this.elapsed();
        this.update({ phase: "listening" });
        const started = Date.now();
        this.timer = setInterval(() => this.update({ elapsedMs: Date.now() - started }), 250);
      } catch (error) {
        if (this.current(generation))
          this.fail(
            error instanceof Error ? error.message : "Microphone unavailable.",
            error instanceof Error && error.name === "NotAllowedError" ? "permission" : "capture"
          );
      }
    }
    handleMessage(data, generation) {
      if (!this.current(generation)) return;
      const target = this.target;
      let message2;
      try {
        message2 = JSON.parse(data);
      } catch {
        this.fail("Invalid voice server response.", "protocol");
        return;
      }
      if (!message2 || typeof message2 !== "object") {
        this.fail("Invalid voice server response.", "protocol");
        return;
      }
      if (message2.type === "ready" && !this.state.value.connected) {
        if (this.state.value.phase !== "finalizing") {
          if (this.timeout) clearTimeout(this.timeout);
          this.timeout = null;
        }
        this.update({ connected: true });
        if (this.diagnostics) this.diagnostics.socketReadyMs = this.elapsed();
        this.allowanceAt = Date.now();
        this.drainAudio(generation);
      } else if (message2.type === "transcript" && (this.state.value.phase === "listening" || this.state.value.phase === "finalizing")) {
        if (typeof message2.id !== "string" || typeof message2.sequence !== "number" || !Number.isSafeInteger(message2.sequence) || typeof message2.text !== "string" || typeof message2.final !== "boolean") {
          this.fail("Invalid transcript response. Current text has been kept.", "protocol");
          return;
        }
        if (this.diagnostics && this.diagnostics.firstTranscriptMs === void 0 && message2.text.trim()) {
          this.diagnostics.firstTranscriptMs = this.elapsed();
        }
        this.segments = replaceSegment(this.segments, {
          id: message2.id,
          sequence: message2.sequence,
          text: message2.text,
          final: message2.final
        });
        const text2 = this.segments.map((segment) => segment.text.trim()).filter(Boolean).join(" ");
        if (text2) {
          const prefix = this.draft.slice(0, this.selection.start);
          const suffix = this.draft.slice(this.selection.end);
          const caret = insertVoiceText(prefix, text2, "").length;
          target.setText(insertVoiceText(prefix, text2, suffix), { start: caret, end: caret });
        } else {
          target.setText(this.draft, this.selection);
        }
      } else if (message2.type === "finished" && this.state.value.phase === "finalizing" && this.finishSent) {
        if (this.intent === "send" && !this.segments.some((segment) => segment.text.trim()) || this.segments.some((segment) => segment.text.trim() && !segment.final)) {
          this.fail("No complete transcript was received. Review current text before using it.", "protocol");
          return;
        }
        const intent = this.intent;
        this.report("finished");
        this.release();
        if (intent === "send") void this.sendDraft();
        else this.detach();
      } else if (message2.type === "error") {
        this.fail(
          typeof message2.message === "string" ? message2.message : "Voice input failed. Current text has been kept."
        );
      }
    }
    enqueueAudio(chunk, generation) {
      if (!this.current(generation) || this.finishSent) return;
      if (this.diagnostics && this.diagnostics.firstAudioMs === void 0) this.diagnostics.firstAudioMs = this.elapsed();
      if (this.queuedBytes + chunk.byteLength + (this.socket?.bufferedAmount ?? 0) > VOICE_MAX_BUFFER_BYTES) {
        this.fail("Voice connection is too slow. Current text has been kept; please try again.", "buffer");
        return;
      }
      for (let offset = 0; offset < chunk.byteLength; offset += VOICE_MAX_FRAME_BYTES) {
        const frame = chunk.slice(offset, offset + VOICE_MAX_FRAME_BYTES);
        this.audioQueue.push(frame);
        this.queuedBytes += frame.byteLength;
      }
      if (this.diagnostics)
        this.diagnostics.peakQueuedBytes = Math.max(this.diagnostics.peakQueuedBytes, this.queuedBytes);
      this.drainAudio(generation);
    }
    drainAudio(generation) {
      const socket = this.socket;
      if (!this.current(generation) || !this.state.value.connected || socket?.readyState !== 1 || this.finishSent) return;
      if (this.drainTimer) clearTimeout(this.drainTimer);
      this.drainTimer = null;
      const now = Date.now();
      this.uploadAllowance = Math.min(
        VOICE_UPLOAD_BURST_BYTES,
        this.uploadAllowance + (now - this.allowanceAt) * VOICE_BYTES_PER_SECOND / 1e3
      );
      this.allowanceAt = now;
      try {
        while (this.audioQueue.length) {
          const frame = this.audioQueue[0];
          if (frame.byteLength > this.uploadAllowance || socket.bufferedAmount + frame.byteLength > VOICE_MAX_BUFFER_BYTES) {
            this.drainTimer = setTimeout(() => this.drainAudio(generation), 25);
            return;
          }
          socket.send(frame);
          this.uploadAllowance -= frame.byteLength;
          this.audioQueue.shift();
          this.queuedBytes -= frame.byteLength;
        }
        if (this.captureFlushed) {
          socket.send(JSON.stringify({ type: "finish" }));
          this.finishSent = true;
        }
      } catch {
        this.fail("Voice connection was interrupted. Current text has been kept.", "connection");
      }
    }
    stop() {
      if (this.state.value.sending) return;
      if (this.state.value.phase === "connecting") this.detach();
      else this.finalize("stop");
    }
    send() {
      if (this.state.value.phase === "listening") this.finalize("send");
      else if (this.state.value.phase === "error") void this.sendDraft();
    }
    async sendDraft() {
      const target = this.target;
      if (!target?.isCurrent() || this.state.value.sending) return;
      this.update({ sending: true });
      const generation = this.generation;
      try {
        const sent = await target.send();
        if (!this.current(generation)) return;
        if (sent) this.detach();
        else this.fail("Message was not sent. Your draft is still available.");
      } catch {
        if (this.current(generation)) this.fail("Message was not sent. Your draft is still available.");
      } finally {
        if (this.current(generation)) this.update({ sending: false });
      }
    }
    finalize(intent) {
      if (this.state.value.phase !== "listening") return;
      this.intent = intent;
      this.update({ phase: "finalizing" });
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.timeout) clearTimeout(this.timeout);
      const generation = this.generation;
      this.timeout = setTimeout(() => {
        if (this.current(generation))
          this.fail("Finalization timed out. Current text is unconfirmed; review it before using it.", "finalize");
      }, 2e4);
      const capture = this.capture;
      void (capture?.stop() ?? Promise.resolve()).then(() => {
        if (!this.current(generation)) return;
        this.capture = null;
        this.captureFlushed = true;
        this.drainAudio(generation);
      }).catch(() => {
        if (this.current(generation))
          this.fail("Could not finalize voice input. Current text has been kept.", "finalize");
      });
    }
    /** Navigation/unmount invalidates callbacks before stopping hardware. No automatic resume. */
    detach() {
      this.report("cancelled");
      this.release(true);
      this.target = null;
      this.state.value = initialState();
    }
    interrupt(reason = "Microphone stopped because this page is no longer active. Review current text before sending or dictating again.") {
      if (["connecting", "listening", "finalizing"].includes(this.state.value.phase)) {
        this.fail(reason, "interrupted");
      }
    }
    elapsed() {
      return Math.max(0, Date.now() - this.startedAt);
    }
    report(outcome, failure) {
      const diagnostic = this.diagnostics;
      if (!diagnostic || !this.target) return;
      this.diagnostics = null;
      this.deps.report(this.target.groupId, {
        ...diagnostic,
        outcome,
        elapsedMs: this.elapsed(),
        ...failure ? { failure } : {}
      });
    }
    fail(error, failure = "provider") {
      this.report("failed", failure);
      this.release(true);
      this.intent = "stop";
      this.update({ phase: "error", error, sending: false });
    }
    release(cancel = false) {
      ++this.generation;
      if (this.timeout) clearTimeout(this.timeout);
      if (this.timer) clearInterval(this.timer);
      if (this.drainTimer) clearTimeout(this.drainTimer);
      this.timeout = this.timer = null;
      this.drainTimer = null;
      this.audioQueue = [];
      this.queuedBytes = 0;
      this.captureAbort?.abort();
      this.captureAbort = null;
      this.capture?.cancel();
      this.capture = null;
      const socket = this.socket;
      this.socket = null;
      if (socket) {
        socket.onmessage = socket.onclose = socket.onerror = null;
        try {
          if (cancel && socket.readyState === 1) socket.send(JSON.stringify({ type: "cancel" }));
          socket.close();
        } catch {
        }
      }
    }
  };

  // src/voice-audio.ts
  function voiceBrowserReason() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
      return "Microphone access requires a supported browser and HTTPS.";
    if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined")
      return "Live voice requires AudioWorklet support in this browser.";
    return null;
  }
  async function captureVoice(onChunk, onError, signal) {
    const reason = voiceBrowserReason();
    if (reason) throw new Error(reason);
    const context = new AudioContext();
    let stream = null;
    let node = null;
    let source = null;
    let closed = false;
    const stopTracks = () => {
      for (const track of stream?.getTracks() ?? []) {
        track.onended = null;
        try {
          track.stop();
        } catch {
        }
      }
    };
    const cancel = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", cancel);
      stopTracks();
      try {
        source?.disconnect();
      } catch {
      }
      try {
        node?.disconnect();
      } catch {
      }
      try {
        void context.close().catch(() => {
        });
      } catch {
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const checkCancelled = () => {
      if (!closed) return;
      stopTracks();
      throw new Error("Microphone capture was cancelled.");
    };
    try {
      checkCancelled();
      const resumed = context.resume();
      const worklet = context.audioWorklet.addModule("/ui/chat/voice-worklet.js");
      const microphone = navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      }).then((value) => {
        stream = value;
        if (closed) {
          stopTracks();
          stream = null;
        }
        return value;
      });
      const [, , readyStream] = await Promise.all([resumed, worklet, microphone]);
      checkCancelled();
      node = new AudioWorkletNode(context, "voice-pcm");
      source = context.createMediaStreamSource(readyStream);
      source.connect(node);
      node.connect(context.destination);
      node.port.onmessage = ({ data }) => {
        if (!closed && data instanceof ArrayBuffer) onChunk(data);
      };
      node.onprocessorerror = () => onError("Audio capture failed. Current text has been kept.");
      for (const track of readyStream.getTracks())
        track.onended = () => onError("Microphone disconnected. Current text has been kept.");
      return {
        cancel,
        stop: () => new Promise((resolve, reject) => {
          if (closed) {
            resolve();
            return;
          }
          const timeout = setTimeout(() => {
            cancel();
            reject(new Error("Audio flush timed out"));
          }, 1e3);
          node.port.onmessage = ({ data }) => {
            if (data instanceof ArrayBuffer) onChunk(data);
            else if (data === "flushed") {
              clearTimeout(timeout);
              cancel();
              resolve();
            }
          };
          try {
            node.port.postMessage("finish");
          } catch (error) {
            clearTimeout(timeout);
            cancel();
            reject(error);
          }
        })
      };
    } catch (error) {
      cancel();
      throw error;
    }
  }
  async function reportVoiceDiagnostic(groupId2, diagnostic) {
    try {
      const response2 = await protocolFetch(`/ui/chat/api/groups/${encodeURIComponent(groupId2)}/voice/diagnostics`, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(diagnostic)
      });
      if (!response2.ok)
        console.warn("Voice diagnostics delivery failed", { attemptId: diagnostic.attemptId, status: response2.status });
    } catch {
      console.warn("Voice diagnostics delivery failed", { attemptId: diagnostic.attemptId });
    }
  }
  var voice = new VoiceController({
    socket: (url) => new WebSocket(url),
    capture: captureVoice,
    origin: () => location.origin,
    attemptId: () => crypto.randomUUID(),
    report: reportVoiceDiagnostic
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) voice.interrupt();
    });
    window.addEventListener("pagehide", () => voice.interrupt());
  }

  // node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js
  var f4 = 0;
  var i4 = Array.isArray;
  function u4(e4, t4, n3, o4, i5, u5) {
    t4 || (t4 = {});
    var a4, c4, p4 = t4;
    if ("ref" in p4) for (c4 in p4 = {}, t4) "ref" == c4 ? a4 = t4[c4] : p4[c4] = t4[c4];
    var l7 = { type: e4, props: p4, key: n3, ref: a4, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: --f4, __i: -1, __u: 0, __source: i5, __self: u5 };
    if ("function" == typeof e4 && (a4 = e4.defaultProps)) for (c4 in a4) void 0 === p4[c4] && (p4[c4] = a4[c4]);
    return l.vnode && l.vnode(l7), l7;
  }

  // src/components/Toast.tsx
  var nextId = 1;
  var hideTimer = null;
  var pending2 = [];
  function displayToast(message2, ms) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    toastMessage.value = message2;
    if (message2.kind === "err" || message2.action) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (toastMessage.value?.id === message2.id) dismissToast();
    }, ms);
  }
  function enqueueToast(message2, ms = 1800) {
    const current = toastMessage.value;
    if (message2.action && message2.action === current?.action && message2.actionLabel === current.actionLabel) {
      displayToast(message2, ms);
    } else if (current?.kind === "err" || current?.actionLabel) {
      pending2.push({ message: message2, ms });
    } else {
      displayToast(message2, ms);
    }
  }
  function showToast(text2, kind = "ok", ms = 1800) {
    const id2 = nextId++;
    enqueueToast({ id: id2, text: text2, kind }, ms);
    return id2;
  }
  function dismissToast() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const next = pending2.shift();
    if (next) displayToast(next.message, next.ms);
    else toastMessage.value = null;
  }

  // src/components/SuggestedResponses.tsx
  function suggestionState(messageId) {
    const conversation2 = conversationState.value?.conversation;
    const sending = pendingWebSends.value.some(
      (send) => send.groupId === groupId.value && send.threadId === threadId.value && send.status !== "failed"
    );
    const active = canSend.value && !!conversation2 && suggestionsActive(messageId, conversation2.messages, conversation2.turns, sending);
    const busy = composerSendInFlight.value || !!currentPendingEditor() || isRecording.value || !["idle", "error"].includes(voice.state.value.phase);
    return { active, disabled: busy };
  }
  function location2() {
    return JSON.stringify([groupId.value, threadId.value, channelType.value, messagingGroupId.value]);
  }
  function replySuggestionControls(messageId) {
    const target = location2();
    return {
      ...suggestionState(messageId),
      choose(text2) {
        const current = suggestionState(messageId);
        if (target !== location2() || !current.active || current.disabled) return;
        const input = document.getElementById("chat-input");
        const result = fillSuggestedDraft(input instanceof HTMLTextAreaElement ? input : null, text2);
        if (!result.filled) showToast(result.error, "err");
      }
    };
  }
  function bindInlineReplyControls(root2, controls) {
    for (const button of root2.querySelectorAll("button.inline-reply-suggestion[data-reply-draft]")) {
      button.disabled = controls.disabled;
      button.addEventListener("click", () => {
        const draft2 = button.dataset.replyDraft;
        if (draft2) controls.choose(draft2);
      });
    }
  }
  function SuggestedResponses({ message: message2 }) {
    const controls = replySuggestionControls(message2.id);
    if (!controls.active) return null;
    return /* @__PURE__ */ u4("div", { class: "reply-suggestions", "aria-label": "Suggested replies", children: message2.suggestedResponses?.map((text2) => /* @__PURE__ */ u4(
      "button",
      {
        type: "button",
        class: "message-action-btn",
        title: `Draft reply: ${text2}`,
        disabled: controls.disabled,
        onClick: () => controls.choose(text2),
        children: text2
      },
      text2
    )) });
  }

  // node_modules/marked/lib/marked.esm.js
  function M2() {
    return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
  }
  var T3 = M2();
  function N2(l7) {
    T3 = l7;
  }
  var _5 = { exec: () => null };
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
  var H = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
  var K = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  var ze = d4("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", K).replace("tag", H).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
  var le = d4(F2).replace("hr", B3).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
  var Me = d4(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", le).getRegex();
  var W = { blockquote: Me, code: we, def: Le, fences: ye, heading: Pe, hr: B3, html: ze, lheading: ae, list: _e, newline: Oe, paragraph: le, table: _5, text: $e };
  var se = d4("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", B3).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
  var Ee = { ...W, lheading: Se, table: se, paragraph: d4(F2).replace("hr", B3).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", se).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex() };
  var Ie = { ...W, html: d4(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", K).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: _5, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: d4(F2).replace("hr", B3).replace("heading", ` *#{1,6} *[^
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
  var J = { _backpedal: _5, anyPunctuation: We, autolink: Xe, blockSkip: He, br: ue, code: Ce, del: _5, delLDelim: _5, delRDelim: _5, emStrongLDelim: Ze, emStrongRDelimAst: Ne, emStrongRDelimUnd: je, escape: Ae, link: Ye, nolink: de, punctuation: De, reflink: ke, reflinkSearch: et, tag: Ve, text: Be, url: _5 };
  var tt = { ...J, link: d4(/^!?\[(label)\]\((.*?)\)/).replace("label", v4).getRegex(), reflink: d4(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", v4).getRegex() };
  var Q = { ...J, emStrongRDelimAst: Qe, emStrongLDelim: Ge, delLDelim: Fe, delRDelim: Ke, url: d4(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol", ie).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: d4(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol", ie).getRegex() };
  var nt = { ...Q, br: d4(ue).replace("{2,}", "*").getRegex(), text: d4(Q.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
  var D2 = { normal: W, gfm: Ee, pedantic: Ie };
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
`), p4 = c4.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
          s5 = s5 ? `${s5}
${c4}` : c4, r4 = r4 ? `${r4}
${p4}` : p4;
          let k4 = this.lexer.state.top;
          if (this.lexer.state.top = true, this.lexer.blockTokens(p4, i5, true), this.lexer.state.top = k4, n3.length === 0) break;
          let h4 = i5.at(-1);
          if (h4?.type === "code") break;
          if (h4?.type === "blockquote") {
            let R = h4, f5 = R.raw + `
` + n3.join(`
`), S3 = this.blockquote(f5);
            i5[i5.length - 1] = S3, s5 = s5.substring(0, s5.length - R.raw.length) + S3.raw, r4 = r4.substring(0, r4.length - R.text.length) + S3.text;
            break;
          } else if (h4?.type === "list") {
            let R = h4, f5 = R.raw + `
` + n3.join(`
`), S3 = this.list(f5);
            i5[i5.length - 1] = S3, s5 = s5.substring(0, s5.length - h4.raw.length) + S3.raw, r4 = r4.substring(0, r4.length - R.raw.length) + S3.raw, n3 = f5.substring(i5.at(-1).raw.length).split(`
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
          let a4 = false, c4 = "", p4 = "";
          if (!(t4 = i5.exec(e4)) || this.rules.block.hr.test(e4)) break;
          c4 = t4[0], e4 = e4.substring(c4.length);
          let k4 = me2(t4[2].split(`
`, 1)[0], t4[1].length), h4 = e4.split(`
`, 1)[0], R = !k4.trim(), f5 = 0;
          if (this.options.pedantic ? (f5 = 2, p4 = k4.trimStart()) : R ? f5 = t4[1].length + 1 : (f5 = k4.search(this.rules.other.nonSpaceChar), f5 = f5 > 4 ? 1 : f5, p4 = k4.slice(f5), f5 += t4[1].length), R && this.rules.other.blankLine.test(h4) && (c4 += h4 + `
`, e4 = e4.substring(h4.length + 1), a4 = true), !a4) {
            let S3 = this.rules.other.nextBulletRegex(f5), te = this.rules.other.hrRegex(f5), ne = this.rules.other.fencesBeginRegex(f5), re = this.rules.other.headingBeginRegex(f5), be = this.rules.other.htmlBeginRegex(f5), Re = this.rules.other.blockquoteBeginRegex(f5);
            for (; e4; ) {
              let G = e4.split(`
`, 1)[0], C3;
              if (h4 = G, this.options.pedantic ? (h4 = h4.replace(this.rules.other.listReplaceNesting, "  "), C3 = h4) : C3 = h4.replace(this.rules.other.tabCharGlobal, "    "), ne.test(h4) || re.test(h4) || be.test(h4) || Re.test(h4) || S3.test(h4) || te.test(h4)) break;
              if (C3.search(this.rules.other.nonSpaceChar) >= f5 || !h4.trim()) p4 += `
` + C3.slice(f5);
              else {
                if (R || k4.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || ne.test(k4) || re.test(k4) || te.test(k4)) break;
                p4 += `
` + h4;
              }
              R = !h4.trim(), c4 += G + `
`, e4 = e4.substring(G.length + 1), k4 = C3.slice(f5);
            }
          }
          r4.loose || (o4 ? r4.loose = true : this.rules.other.doubleBlankLine.test(c4) && (o4 = true)), r4.items.push({ type: "list_item", raw: c4, task: !!this.options.gfm && this.rules.other.listIsTask.test(p4), loose: false, text: p4, tokens: [] }), r4.raw += c4;
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
            let p4 = this.rules.other.listTaskCheckbox.exec(a4.raw);
            if (p4) {
              let k4 = { type: "checkbox", raw: p4[0] + " ", checked: p4[0] !== "[ ]" };
              a4.checked = k4.checked, r4.loose ? a4.tokens[0] && ["paragraph", "text"].includes(a4.tokens[0].type) && "tokens" in a4.tokens[0] && a4.tokens[0].tokens ? (a4.tokens[0].raw = k4.raw + a4.tokens[0].raw, a4.tokens[0].text = k4.raw + a4.tokens[0].text, a4.tokens[0].tokens.unshift(k4)) : a4.tokens.unshift({ type: "paragraph", raw: k4.raw, text: k4.raw, tokens: [k4] }) : a4.tokens.unshift(k4);
            }
          } else a4.task && (a4.task = false);
          if (!r4.loose) {
            let p4 = a4.tokens.filter((h4) => h4.type === "space"), k4 = p4.length > 0 && p4.some((h4) => this.rules.other.anyLine.test(h4.raw));
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
        let i5 = [...s5[0]].length - 1, o4, u5, a4 = i5, c4 = 0, p4 = s5[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
        for (p4.lastIndex = 0, t4 = t4.slice(-1 * e4.length + i5); (s5 = p4.exec(t4)) !== null; ) {
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
          let k4 = [...s5[0]][0].length, h4 = e4.slice(0, i5 + s5.index + k4 + u5);
          if (Math.min(i5, u5) % 2) {
            let f5 = h4.slice(1, -1);
            return { type: "em", raw: h4, text: f5, tokens: this.lexer.inlineTokens(f5) };
          }
          let R = h4.slice(2, -2);
          return { type: "strong", raw: h4, text: R, tokens: this.lexer.inlineTokens(R) };
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
          let p4 = [...s5[0]][0].length, k4 = e4.slice(0, i5 + s5.index + p4 + u5), h4 = k4.slice(i5, -i5);
          return { type: "del", raw: k4, text: h4, tokens: this.lexer.inlineTokens(h4) };
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
      let t4 = { other: m5, block: D2.normal, inline: A4.normal };
      this.options.pedantic ? (t4.block = D2.pedantic, t4.inline = A4.pedantic) : this.options.gfm && (t4.block = D2.gfm, this.options.breaks ? t4.inline = A4.breaks : t4.inline = A4.gfm), this.tokenizer.rules = t4;
    }
    static get rules() {
      return { block: D2, inline: A4 };
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
        if (this.options.extensions?.inline?.some((p4) => (a4 = p4.call({ lexer: this }, e4, t4)) ? (e4 = e4.substring(a4.raw.length), t4.push(a4), true) : false)) continue;
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
          let p4 = t4.at(-1);
          a4.type === "text" && p4?.type === "text" ? (p4.raw += a4.raw, p4.text += a4.text) : t4.push(a4);
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
          let p4 = 1 / 0, k4 = e4.slice(1), h4;
          this.options.extensions.startInline.forEach((R) => {
            h4 = R.call({ lexer: this }, k4), typeof h4 == "number" && h4 >= 0 && (p4 = Math.min(p4, h4));
          }), p4 < 1 / 0 && p4 >= 0 && (c4 = e4.substring(0, p4 + 1));
        }
        if (a4 = this.tokenizer.inlineText(c4)) {
          e4 = e4.substring(a4.raw.length), a4.raw.slice(-1) !== "_" && (o4 = a4.raw.slice(-1)), i5 = true;
          let p4 = t4.at(-1);
          p4?.type === "text" ? (p4.raw += a4.raw, p4.text += a4.text) : t4.push(a4);
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
  var q2 = class {
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
              let p4 = u5.apply(r4, c4);
              return p4 === false && (p4 = a4.apply(r4, c4)), p4 || "";
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
              let p4 = u5.apply(r4, c4);
              return p4 === false && (p4 = a4.apply(r4, c4)), p4;
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
              let p4 = u5.call(r4, c4);
              return a4.call(r4, p4);
            } : r4[o4] = (...c4) => {
              if (this.defaults.async) return (async () => {
                let k4 = await u5.apply(r4, c4);
                return k4 === false && (k4 = await a4.apply(r4, c4)), k4;
              })();
              let p4 = u5.apply(r4, c4);
              return p4 === false && (p4 = a4.apply(r4, c4)), p4;
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
          let u5 = i5.hooks ? await i5.hooks.preprocess(n3) : n3, c4 = await (i5.hooks ? await i5.hooks.provideLexer(e4) : e4 ? x4.lex : x4.lexInline)(u5, i5), p4 = i5.hooks ? await i5.hooks.processAllTokens(c4) : c4;
          i5.walkTokens && await Promise.all(this.walkTokens(p4, i5.walkTokens));
          let h4 = await (i5.hooks ? await i5.hooks.provideParser(e4) : e4 ? b3.parse : b3.parseInline)(p4, i5);
          return i5.hooks ? await i5.hooks.postprocess(h4) : h4;
        })().catch(o4);
        try {
          i5.hooks && (n3 = i5.hooks.preprocess(n3));
          let a4 = (i5.hooks ? i5.hooks.provideLexer(e4) : e4 ? x4.lex : x4.lexInline)(n3, i5);
          i5.hooks && (a4 = i5.hooks.processAllTokens(a4)), i5.walkTokens && this.walkTokens(a4, i5.walkTokens);
          let p4 = (i5.hooks ? i5.hooks.provideParser(e4) : e4 ? b3.parse : b3.parseInline)(a4, i5);
          return i5.hooks && (p4 = i5.hooks.postprocess(p4)), p4;
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
  var z3 = new q2();
  function g4(l7, e4) {
    return z3.parse(l7, e4);
  }
  g4.options = g4.setOptions = function(l7) {
    return z3.setOptions(l7), g4.defaults = z3.defaults, N2(g4.defaults), g4;
  };
  g4.getDefaults = M2;
  g4.defaults = T3;
  g4.use = function(...l7) {
    return z3.use(...l7), g4.defaults = z3.defaults, N2(g4.defaults), g4;
  };
  g4.walkTokens = function(l7, e4) {
    return z3.walkTokens(l7, e4);
  };
  g4.parseInline = z3.parseInline;
  g4.Parser = b3;
  g4.parser = b3.parse;
  g4.Renderer = y4;
  g4.TextRenderer = L2;
  g4.Lexer = x4;
  g4.lexer = x4.lex;
  g4.Tokenizer = w4;
  g4.Hooks = P2;
  g4.parse = g4;
  var Ft = g4.options;
  var Ut = g4.setOptions;
  var Kt = g4.use;
  var Wt = g4.walkTokens;
  var Xt = g4.parseInline;
  var Vt = b3.parse;
  var Yt = x4.lex;

  // src/utils.ts
  function markdownRenderer(inlineReplies) {
    const renderer = new y4();
    renderer.link = function({ href, title, tokens }) {
      const text2 = this.parser.parseInline(tokens);
      if (/^reply:/i.test(href)) {
        const draft2 = inlineReplyDraft(href);
        if (!inlineReplies || draft2 === null) return text2;
        const value = draft2.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
        return `<button type="button" class="inline-reply-suggestion" data-reply-draft="${value}" title="Draft reply: ${value}" aria-description="Draft reply: ${value}">${text2}<span aria-hidden="true"> \u21B5</span></button>`;
      }
      const isAbs = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
      const titleAttr = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
      const targetAttr = isAbs ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${href}"${titleAttr}${targetAttr}>${text2}</a>`;
    };
    return renderer;
  }
  g4.use({
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
  function normalizeFileLinks(text2) {
    const re = /\[([^\]\n]+)\]\(([^<>\n()]*(?:\([^()\n]*\)[^<>\n()]*)*)\)/g;
    return text2.replace(re, (match, label, dest) => {
      const d5 = dest.trim();
      if (!d5) return match;
      if (/^[a-z][a-z0-9+.-]*:/i.test(d5)) return match;
      if (d5.startsWith("#") || d5.startsWith("//") || d5.startsWith("mailto:")) return match;
      if (!/[ ()]/.test(d5)) return match;
      return `[${label}](<${d5}>)`;
    });
  }
  var isExternalFileRef = (ref) => /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("#") || ref.startsWith("//") || ref.startsWith("mailto:");
  var isGroupFileRef = (ref) => /^\/?(?:ui\/chat\/)?api\/groups\//.test(ref);
  function decodeFileRef(ref) {
    try {
      return decodeURIComponent(ref);
    } catch {
      return ref;
    }
  }
  function normalizeFileRef(ref) {
    return String(ref || "").replace(/^\.?\/+/, "").replace(/^workspace\/+/, "");
  }
  function toGroupFileUrl(groupId2, rel) {
    const gid = encodeURIComponent(groupId2);
    const segs = rel.split("/").filter(Boolean).map(encodeURIComponent);
    return `api/groups/${gid}/files/${segs.join("/")}`;
  }
  function renderMarkdown(text2, groupId2, inlineReplies = false) {
    try {
      const html = g4.parse(normalizeFileLinks(text2 || ""), {
        breaks: true,
        gfm: true,
        renderer: markdownRenderer(inlineReplies)
      });
      if (!groupId2 || typeof document === "undefined") return html;
      const template = document.createElement("template");
      template.innerHTML = html;
      template.content.querySelectorAll("img[src]").forEach((img) => {
        const src = img.getAttribute("src") || "";
        if (!src || isExternalFileRef(src) || isGroupFileRef(src)) return;
        const rel = normalizeFileRef(decodeFileRef(src));
        if (rel) img.setAttribute("src", toGroupFileUrl(groupId2, rel));
      });
      return template.innerHTML;
    } catch {
      return null;
    }
  }

  // src/reply-suggestions-demo.tsx
  var completed = y2(false);
  var messages = y2([]);
  var draft = y2("");
  var turn2 = {
    id: "demo-turn",
    phase: "settled",
    outcome: "replied",
    startedAt: 1,
    endedAt: 2,
    inputIds: [],
    outputIds: ["demo-response"],
    activity: [],
    usage: [],
    metadata: { status: "unavailable", model: null, durationMs: null }
  };
  var response = {
    id: "demo-response",
    direction: "out",
    timestamp: 2,
    turnId: turn2.id,
    deliveryOrigin: "response",
    text: "I found three ways to reduce your budget. Start with [subscriptions](reply:Please%20review%20my%20subscriptions%20and%20identify%20unnecessary%20costs.) or [dining out](reply:Please%20suggest%20a%20realistic%20plan%20to%20reduce%20dining-out%20spending.).",
    suggestedResponses: ["Show all three approaches", "Help me set a savings target"]
  };
  function sync() {
    const conversation2 = {
      threadId: "demo-thread",
      messages: messages.value,
      turns: completed.value ? [turn2] : [],
      interactions: [],
      timeline: [],
      connection: { connected: true, activeTurnId: null },
      capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false }
    };
    conversationState.value = {
      kind: "snapshot",
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      streamId: "isolated-prototype",
      revision: 1,
      conversation: conversation2
    };
  }
  function reset() {
    completed.value = false;
    messages.value = [];
    draft.value = "";
    toastMessage.value = null;
    const input = document.getElementById("chat-input");
    if (input instanceof HTMLTextAreaElement) input.value = "";
    sync();
  }
  groupId.value = "demo-group";
  threadId.value = "demo-thread";
  canSend.value = true;
  sync();
  function DemoMessage({ message: message2 }) {
    const ref = A2(null);
    const controls = replySuggestionControls(message2.id);
    const html = renderMarkdown(message2.text, null, controls.active);
    _2(() => {
      if (!ref.current) return;
      ref.current.innerHTML = html;
      if (controls.active) bindInlineReplyControls(ref.current, controls);
    }, [html, controls.active, controls.disabled]);
    return /* @__PURE__ */ u4("article", { class: `msg ${message2.direction}`, children: [
      /* @__PURE__ */ u4("div", { ref, dangerouslySetInnerHTML: { __html: html } }),
      message2.suggestedResponses ? /* @__PURE__ */ u4(SuggestedResponses, { message: message2 }) : null
    ] });
  }
  function Demo() {
    return /* @__PURE__ */ u4("main", { class: "prototype", children: [
      /* @__PURE__ */ u4("header", { children: [
        /* @__PURE__ */ u4("h1", { children: "Optional reply drafts" }),
        /* @__PURE__ */ u4("p", { children: "Isolated simulation. No service, credentials, agent calls, or live data." }),
        /* @__PURE__ */ u4("div", { class: "demo-controls", children: [
          /* @__PURE__ */ u4(
            "button",
            {
              type: "button",
              onClick: () => {
                completed.value = true;
                messages.value = [response];
                sync();
              },
              disabled: completed.value,
              children: "Complete agent response"
            }
          ),
          /* @__PURE__ */ u4("button", { type: "button", onClick: reset, children: "Reset" })
        ] })
      ] }),
      /* @__PURE__ */ u4("section", { class: "transcript chat-main", "aria-label": "Transcript", children: [
        !completed.value ? /* @__PURE__ */ u4("p", { class: "working", role: "status", children: "Agent is composing its response. The composer stays available." }) : null,
        messages.value.map((message2) => /* @__PURE__ */ u4(DemoMessage, { message: message2 }, message2.id))
      ] }),
      /* @__PURE__ */ u4(
        "form",
        {
          onSubmit: (event) => {
            event.preventDefault();
            const input = document.getElementById("chat-input");
            if (!(input instanceof HTMLTextAreaElement) || !input.value.trim()) return;
            messages.value = [
              ...messages.value,
              {
                id: `demo-input-${messages.value.length}`,
                direction: "in",
                timestamp: Date.now(),
                text: input.value
              }
            ];
            input.value = "";
            draft.value = "";
            sync();
          },
          children: [
            /* @__PURE__ */ u4("label", { for: "chat-input", children: "Your message" }),
            /* @__PURE__ */ u4(
              "textarea",
              {
                id: "chat-input",
                rows: 3,
                placeholder: "Type anything, or choose a suggested draft",
                onInput: (event) => {
                  draft.value = event.currentTarget.value;
                }
              }
            ),
            /* @__PURE__ */ u4("button", { type: "submit", disabled: !draft.value.trim(), children: "Send in simulation" }),
            /* @__PURE__ */ u4("p", { children: "Choosing a button fills this draft. Edit it before sending, or ignore the buttons." })
          ]
        }
      ),
      toastMessage.value ? /* @__PURE__ */ u4("p", { class: "demo-error", role: "alert", children: toastMessage.value.text }) : null
    ] });
  }
  var root = document.getElementById("prototype");
  if (!root) throw new Error("Prototype root missing");
  D(/* @__PURE__ */ u4(Demo, {}), root);
})();
