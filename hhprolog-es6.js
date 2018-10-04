;(function(context) {
"use strict";

var trace = function trace() {
    var msg = Array.from(arguments).map(
        e => typeof e === 'string' ? e : JSON.stringify(e)
    ).join(' ')
    if (document)
        document.write('<pre>'+msg+'</pre>')
    else
        console.log(msg)
}
context.trace = trace

// RegExes set
var SPACE = '\\s+'
var ATOM  = '[a-z]\\w*'
var VAR   = '[A-Z_]\\w*'
var NUM   = '-?\\d+'
var DOT   = '\\.'

var IF    = "if"
var AND   = "and"
var HOLDS = "holds"

var NIL   = "nil"
var LISTS = "lists"
var IS    = "is"  // ?

function Toks() {
    
    this.makeToks = (s)=>{
        var e = new RegExp(`(${SPACE})|(${ATOM})|(${VAR})|(${NUM})|(${DOT})`)

        function token(r) {
            if (r && r.index === 0) {
                function tkAtom(s) {
                    var k = [IF, AND, HOLDS, NIL, LISTS, IS].indexOf(s)
                    return {t: k < 0 ? ATOM : s, s: s}
                }
                var tkVar=s=>{
                   return { t: VAR, s: r[0] }
                }
                function tkNum(s) {
                    return { t: NUM, s: s, n: parseInt(s) }
                }
                if (r[1]) return { t: SPACE, s: r[0] }
                if (r[2]) return tkAtom(r[0])
                if (r[3]) return tkVar(r[0])
                if (r[4]) return tkNum(r[0])
                if (r[5]) return { t: DOT, s: r[0] }
            }
        }
        var tokens = [], r
        while (r = token(e.exec(s))) {
            if (r.t !== SPACE)
                tokens.push(r)
            s = s.substring(r.s.length)
        }
        if (s.length)
            throw ` error at '${s}'`
        return tokens
    }

    this.toSentences = (s)=>{
        var Wsss = []
        var Wss = []
        var Ws = []
        this.makeToks(s).forEach(t => {
            switch (t.t) {
            case DOT:
                Wss.push(Ws)
                Wsss.push(Wss)
                Wss = []
                Ws = []
                break
            case IF:
                Wss.push(Ws)
                Ws = []
                break
            case AND:
                Wss.push(Ws)
                Ws = []
                break
            case HOLDS:
                Ws[0] = "h:" + Ws[0].substring(2)
                break
            case LISTS:
                Ws[0] = "l:" + Ws[0].substring(2)
                break
            case IS:
                Ws[0] = "f:" + Ws[0].substring(2)
                break

            case VAR:
                Ws.push("v:" + t.s)
                break
            case NUM:
                if (t.n < (1 << 28))
                    Ws.push("n:" + t.s)
                else
                    Ws.push("c:" + t.s)
                break
            case ATOM:
            case NIL:
                Ws.push("c:" + t.s)
                break

            default:
                throw 'unknown token:'+JSON.stringify(t)
            }
        })
        return Wsss
    }
}

/**
 * representation of a clause
 */
var Clause = (len, hgs, base, neck, xs)=>{
    return {
        hgs    : hgs,   // head+goals pointing to cells in cs
        base   : base,  // heap where this starts
        len    : len,   // length of heap slice
        neck   : neck,  // first after the end of the head
        xs     : xs,    // indexables in head
    }
}
var Spine6 = (gs0, base, gs, ttop, k, cs)=>{
    return {
        hd      : gs0[0],
        base    : base,
        gs      : gs0.concat(gs).slice(1), // prepends the goals of clause with head hs
        ttop    : ttop,
        k       : k,
        cs      : cs,
        xs      : [],
    }
}
var Spine2 = (hd, ttop)=>{
    return {
        hd      : hd,   // head of the clause to which this corresponds
        base    : 0,    // top of the heap when this was created
        gs      : [],   // goals - with the top one ready to unfold
        ttop    : ttop, // top of the trail when this was created
        k       : -1,
        cs      : null, // array of clauses known to be unifiable with top goal in gs
        xs      : [],
    }
}

var MINSIZE = 1 << 15 // power of 2

//////////// IMap.java

var IMap = function IMap() {
    this.map = []
}
IMap.prototype.put = function(key, val) {
    if (!this.map[key])
        this.map[key] = [];
    this.map[key][val] = 666;
}

//////////// Engine.java

var MAXIND = 3 // number of index args
var START_INDEX = 20

var pp = trace

/**
 * tags of our heap cells - that can also be seen as
 * instruction codes in a compiled implementation
 */
var V = 0
var U = 1
var R = 2

var C = 3
var N = 4

var A = 5

// G - ground?
var BAD = 7

/**
 * Implements execution mechanism
 */
var Engine = function Engine(asm_nl_source) {

    /**
     * Builds a new engine from a natural-language style assembler.nl file
     */

    this.syms = []
    this.addSym = (sym)=>{
        var I = this.syms.indexOf(sym)
        if (I === -1) {
            I = this.syms.length
            this.syms.push(sym)
        }
        return I
    }
    this.getSym = (w)=>{
        if (w < 0 || w >= this.syms.length)
            throw "BADSYMREF=" + w
        return this.syms[w]
    }
    
    this.makeHeap = (size)=>{
        size = size || MINSIZE
        this.heap = Array(size).fill(0)
        this.clear()
    }
    this.clear = ()=>{
        for (var i = 0; i <= this.top; i++)
            this.heap[i] = 0
        this.top = -1
    }
    this.push = (i)=>{
        this.heap[++this.top] = i
    }
    this.size = ()=>{
        return this.top + 1
    }
    
    this.expand = ()=>{
        this.heap.length = this.heap.length * 2
    }
    this.ensureSize = (more)=>{
        if (1 + this.top + more >= this.heap.length)
            this.expand()
    }

    this.dload = (s)=>{
        var Wsss = (new Toks).toSentences(s)
        var Cs = []
        for (var Wss of Wsss) {
            var refs = {}
            var cs = []
            var gs = []

            var Rss = mapExpand(Wss)
            var k = 0
            for (var ws of Rss) {

                var l = ws.length
                gs.push(tag(R, k++))
                cs.push(tag(A, l))

                for (var w of ws) {

                    // head or body subterm starts here
                    if (1 == w.length)
                        w = "c:" + w

                    var L = w.substring(2)

                    switch (w[0]) {
                    case 'c':
                        cs.push(this.encode(C, L))
                        k++
                        break
                    case 'n':
                        cs.push(this.encode(N, L))
                        k++
                        break
                    case 'v':
                        if (refs[L] === undefined)
                            refs[L] = []
                        refs[L].push(k)
                        cs.push(tag(BAD, k))  // just in case we miss this
                        k++
                        break
                    case 'h':
                        if (refs[L] === undefined)
                            refs[L] = []
                        refs[L].push(k - 1)
                        cs[k - 1] = tag(A, l - 1)
                        gs.pop()
                        break
                    default:
                        pp("FORGOTTEN=" + w)
                    } // end subterm
                } // end element
            } // end clause

            // linker
            for (var kIs in refs) {
                var Is = refs[kIs]
                
                // finding the A among refs
                var leader = -1
                for (var j of Is) {
                    if (A == tagOf(cs[j])) {
                        leader = j
                        break
                    }
                }
                if (-1 == leader) {
                    // for vars, first V others U
                    leader = Is[0]
                    for (var i of Is) {
                        if (i == leader) {
                            cs[i] = tag(V, i)
                        } else {
                            cs[i] = tag(U, leader)
                        }
                    }
                } else {
                    for (var i of Is) {
                        if (i == leader) {
                            continue
                        }
                        cs[i] = tag(R, leader)
                    }
                }
            }

            var neck = 1 == gs.length ? cs.length : detag(gs[1])
            var tgs = gs
            Cs.push(this.putClause(cs, tgs, neck))
        } // end clause set

        return Cs
    }

    this.getRef=x=>this.heap[detag(x)]
    this.setRef=(w, r)=>{ this.heap[detag(w)] = r }
    this.encode=(t, s)=>{
        var w = parseInt(s)
        if (isNaN(w)) {
            if (C == t)
                w = this.addSym(s)
            else
                throw "bad in encode=" + t + ":" + s
        }
        return tag(t, w)
    }
    this.unwindTrail=(savedTop)=>{
        while (savedTop < this.trail.length - 1) {
            var href = this.trail.pop()
            this.setRef(href, href)
        }
    }
    this.deref_opt=(x)=>{
        while ((-x & 7) < 2) {
            var r = this.heap[-x >> 3]
            if (r == x)
                break
            x = r
        }
        return x
    }
    this.deref=(x)=>{
        while (isVAR(x)) {
            var r = this.getRef(x)
            if (r == x)
                break
            x = r
        }
        return x
    }
    this.showTerm=(x)=>{
        if (typeof x === 'number')
            return this.showTerm(this.exportTerm(x))
        if (x instanceof Array)
            return x.join(',')
        return '' + x
    }
    this.ppTrail=()=>{
        for (var i = 0; i <= array_last(this.trail, -1); i++) {
            var t = this.trail[i]
            pp("trail[" + i + "]=" + this.showCell(t) + ":" + this.showTerm(t))
        }
    }
    this.exportTerm=x=>{
        x = this.deref(x)

        var t = tagOf(x)
        var w = detag(x)

        var res = null
        switch (t) {
        case C:
            res = this.getSym(w)
            break
        case N:
            res = parseInt(w)
            break
        case V:
        //case U:
            res = "V" + w
            break
        case R: {
            var a = this.heap[w]
            if (A != tagOf(a))
                throw "*** should be A, found=" + this.showCell(a)
            var n = detag(a)
            var arr = Array(n).fill()
            var k = w + 1
            for (var i = 0; i < n; i++) {
                var j = k + i
                arr[i] = this.exportTerm(this.heap[j])
            }
            res = arr
        }   break
        default:
            throw "*BAD TERM*" + this.showCell(x)
        }
        return res
    }
    this.showCell=(w)=>{
        var t = tagOf(w)
        var val = detag(w)
        var s = null
        switch (t) {
        case V:
            s = "v:" + val
            break
        case U:
            s = "u:" + val
            break
        case N:
            s = "n:" + val
            break
        case C:
            s = "c:" + this.getSym(val)
            break
        case R:
            s = "r:" + val
            break
        case A:
            s = "a:" + val
            break
        default:
            s = "*BAD*=" + w
        }
        return s
    }
    this.showCells2=(base, len)=>{
        var buf = ''
        for (var k = 0; k < len; k++) {
            var instr = this.heap[base + k]
            buf += "[" + (base + k) + "]" + this.showCell(instr) + " "
        }
        return buf
    }

    this.showCells1=(cs)=>{
        var buf = ''
        for (var k = 0; k < cs.length; k++)
            buf += "[" + k + "]" + this.showCell(cs[k]) + " "
        return buf
    }

    // to be overridden
    this.ppc=C=>{}
    this.ppGoals=gs=>{}
    this.ppSpines=()=>{}

    this.unify=base=>{
        while (this.ustack.length) {
            var x1 = this.deref(this.ustack.pop())
            var x2 = this.deref(this.ustack.pop())
            if (x1 != x2) {
                var t1 = tagOf(x1)
                var t2 = tagOf(x2)
                var w1 = detag(x1)
                var w2 = detag(x2)
                if (isVAR(x1)) { /* unb. var. v1 */
                    if (isVAR(x2) && w2 > w1) { /* unb. var. v2 */
                        this.heap[w2] = x1
                        if (w2 <= base) {
                            this.trail.push(x2)
                        }
                    } else { // x2 nonvar or older
                        this.heap[w1] = x2
                        if (w1 <= base)
                            this.trail.push(x1)
                    }
                } else if (isVAR(x2)) { /* x1 is NONVAR */
                    this.heap[w2] = x1
                    if (w2 <= base)
                        this.trail.push(x2)
                } else if (R == t1 && R == t2) { // both should be R
                    if (!this.unify_args(w1, w2))
                        return false
                } else
                    return false
            }
        }
        return true
    }

    this.unify_args=(w1, w2)=>{
        var v1 = this.heap[w1]
        var v2 = this.heap[w2]
        // both should be A
        var n1 = detag(v1)
        var n2 = detag(v2)
        if (n1 != n2)
            return false
        var b1 = 1 + w1
        var b2 = 1 + w2
        for (var i = n1 - 1; i >= 0; i--) {
            var i1 = b1 + i
            var i2 = b2 + i
            var u1 = this.heap[i1]
            var u2 = this.heap[i2]
            if (u1 == u2) {
                continue
            }
            this.ustack.push(u2)
            this.ustack.push(u1)
        }
        return true
    }
    this.putClause=(cs, gs, neck)=>{
        var base = this.size()
        var b = tag(V, base)
        var len = cs.length
        this.pushCells2(b, 0, len, cs)
        for (var i = 0; i < gs.length; i++) {
            gs[i] = relocate(b, gs[i])
        }
        var xs = this.getIndexables(gs[0])
        return Clause(len, gs, base, neck, xs)
    }
    this.pushCells1=(b, from, to, base)=>{
        this.ensureSize(to - from)
        for (var i = from; i < to; i++) {
            this.push(relocate(b, this.heap[base + i]))
        }
    }
    this.pushCells2=(b, from, to, cs)=>{
        this.ensureSize(to - from)
        for (var i = from; i < to; i++) {
            this.push(relocate(b, cs[i]))
        }
    }
    this.pushHead=(b, C)=>{
        this.pushCells1(b, 0, C.neck, C.base)
        var head = C.hgs[0]
        return relocate(b, head)
    }
    this.pushBody=(b, head, C)=>{
        this.pushCells1(b, C.neck, C.len, C.base)
        var l = C.hgs.length
        var gs = Array(l).fill(0)
        gs[0] = head
        for (var k = 1; k < l; k++) {
            var cell = C.hgs[k]
            gs[k] = relocate(b, cell)
        }
        return gs
    }
    this.makeIndexArgs=(G)=>{
        var goal = G.gs[0]
        if (G.xs.length)
            return
        var p = 1 + detag(goal)
        var n = Math.min(MAXIND, detag(this.getRef(goal)))

        var xs = Array(MAXIND).fill(0)
        for (var i = 0; i < n; i++) {
            var cell = this.deref(this.heap[p + i])
            xs[i] = this.cell2index(cell)
        }
        G.xs = xs
        if (null == this.imaps)
            return
        var cs = IMap.get(imaps, vmaps, xs)
        G.cs = cs
    }

    this.getIndexables=(ref)=>{
        var p = 1 + detag(ref)
        var n = detag(this.getRef(ref))
        var xs = Array(MAXIND).fill(0)
        for (var i = 0; i < MAXIND && i < n; i++) {
            var cell = this.deref(this.heap[p + i])
            xs[i] = this.cell2index(cell)
        }
        return xs
    }

    this.cell2index=(cell)=>{
        var x = 0
        var t = tagOf(cell)
        switch (t) {
        case R:
            x = this.getRef(cell)
            break
        case C:
        case N:
            x = cell
            break
        // 0 otherwise - assert: tagging with R,C,N <>0
        }
        return x
    }
    this.match=(xs, C0)=>{
        for (var i = 0; i < MAXIND; i++) {
            var x = xs[i]
            var y = C0.xs[i]
            if (0 == x || 0 == y) {
                continue
            }
            if (x != y)
                return false
        }
        return true
    }
    this.unfold=(G)=>{

        var ttop = this.trail.length - 1
        var htop = this.top
        var base = htop + 1

        this.makeIndexArgs(G)

        var last = G.cs.length
        for (var k = G.k; k < last; k++) {
            var C0 = this.clauses[G.cs[k]]

            if (!this.match(G.xs, C0))
                continue

            var base0 = base - C0.base
            var b = tag(V, base0)
            var head = this.pushHead(b, C0)

            this.ustack.length = 0 // set up unification stack

            this.ustack.push(head)
            this.ustack.push(G.gs[0])

            if (!this.unify(base)) {
                this.unwindTrail(ttop)
                this.top = htop
                continue
            }

            var gs = this.pushBody(b, head, C0)
            var newgs = gs.concat(G.gs.slice(1)).slice(1)
            G.k = k + 1
            if (newgs.length)
                return Spine6(gs, base, G.gs.slice(1), ttop, 0, this.cls)
            else
                return this.answer(ttop)
        } // end for
        return null
    }
    this.getQuery=()=>array_last(this.clauses, null)
    this.init=()=>{
        var base = this.size()
        var G = this.getQuery()
        var Q = Spine6(G.hgs, base, [], array_last(this.trail, -1), 0, this.cls)
        this.spines.push(Q)
        return Q
    }
    this.answer=ttop=>Spine2(this.spines[0].hd, ttop)
    this.popSpine=()=>{
        var G = this.spines.pop()
        this.unwindTrail(G.ttop)
        this.top = G.base - 1
    }
    this.yield_=()=>{
        while (this.spines.length) {
            var G = array_last(this.spines, null)
            var C = this.unfold(G)
            if (null == C) {
                this.popSpine() // no matches
                continue
            }

            if (hasGoals(C)) {
                this.spines.push(C)
                continue
            }
            return C // answer
        }
        return null
    }
    this.heap2s=()=>'[' + this.top + ' ' + this.heap.slice(0,this.top).map((x,y) => /*'['+y+']'+*/heapCell(x)).join(',') + ']'
    this.ask=()=>{
        this.query = this.yield_()
        if (null == this.query)
            return null
        var res = this.answer(this.query.ttop).hd
        var R = this.exportTerm(res)
        this.unwindTrail(this.query.ttop)
        return R
    }
    this.run=(print_ans)=>{
        var ctr = 0
        for (;; ctr++) {
            var A = this.ask()
            if (null == A)
                break
            if (print_ans)
                pp("[" + ctr + "] " + "*** ANSWER=" + this.showTerm(A))
        }
        pp("TOTAL ANSWERS=" + ctr)
    }
    this.vcreate=(l)=>{
        var vss = []
        for (var i = 0; i < l; i++)
            vss.push([])
        return vss
    }
    this.put=(imaps, vss, keys, val)=>{
        for (var i = 0; i < imaps.length; i++) {
            var key = keys[i]
            if (key != 0) {
                imaps[i][key] = val
            } else {
                vss[i].add(val)
            }
        }
    }

    this.index=(clauses, vmaps)=>{
        if (clauses.length < START_INDEX)
            return null

        var T = JSON.stringify
        var imaps = Array(vmaps.length)
        for (var i = 0; i < clauses.length; i++) {
            var c = clauses[i]
            pp("!!!xs=" + T(c.xs) + ":" + this.showCells1(c.xs) + "=>" + i)
            this.put(imaps, vmaps, c.xs, i + 1) // $$$ UGLY INC
            pp(T(imaps))
        }
        pp("INDEX")
        pp(T(imaps))
        pp(T(vmaps))
        pp("")
        return imaps
    }

    /** runtime areas:
     *
     * the heap contains code for clauses and their copies
     * created during execution
     *
     * the trail is an undo list for variable bindings
     * that facilitates retrying failed goals with alternative
     * matching clauses
     *
     * the unification stack ustack helps handling term unification non-recursively
     *
     * the spines stack contains abstractions of clauses and goals and performs the
     * functions of both a choice-point stack and goal stack
     *
     * imaps: contains indexes for up to MAXIND>0 arg positions (0 for pred symbol itself)
     *
     * vmaps: contains clause numbers for which vars occur in indexed arg positions
     */

    this.makeHeap(50)

    this.trail = []
    this.ustack = []
    this.spines = []

    /**
     * trimmed down clauses ready to be quickly relocated to the heap
     */
    this.clauses = this.dload(asm_nl_source)

    /** symbol table made of map + reverse map from ints to syms */
    this.cls = toNums(this.clauses)

    this.query = this.init()

    this.vmaps = this.vcreate(MAXIND)
    this.imaps = this.index(this.clauses, this.vmaps)
}

var tag = (t, w) => -((w << 3) + t)
var detag = (w) => -w >> 3
var tagOf = (w) => -w & 7

var tagSym = (t) =>
    t === V ? "V" :
    t === U ? "U" :
    t === R ? "R" :
    t === C ? "C" :
    t === N ? "N" :
    t === A ? "A" : "?"

var heapCell = (w) => tagSym(tagOf(w))+":"+detag(w)+"["+w+"]"
var isVAR = (x) => tagOf(x) < 2

var maybeExpand = (Ws)=>{
    var W = Ws[0]
    if (W.length < 2 || "l:" !== W.substring(0, 2))
        return null

    var l = Ws.length
    var Rss = []
    var V = W.substring(2)
    for (var i = 1; i < l; i++) {
        var Vi = 1 == i ? V : V + "__" + (i - 1)
        var Vii = V + "__" + i
        var Rs = ["h:" + Vi, "c:list", Ws[i], i == l - 1 ? "c:nil" : "v:" + Vii]
        Rss.push(Rs)
    }
    return Rss
}
var mapExpand=(Wss)=>{
    var Rss = []
    for (var Ws of Wss) {
        var Hss = maybeExpand(Ws)
        if (null == Hss) {
            Rss.push(Ws)
        } else
            for (var X of Hss)
                Rss.push(X)
    }
    return Rss
}

var toNums=(clauses)=>{
    return Array(clauses.length).fill().map((_, i) => i)
}

var getSpine=(cs)=>{
    var a = cs[1]
    var w = detag(a)
    var rs = Array(w - 1).fill()
    for (var i = 0; i < w - 1; i++) {
        var x = cs[3 + i]
        var t = tagOf(x)
        if (R != t)
            throw "*** getSpine: unexpected tag=" + t
        rs[i] = detag(x)
    }
    return rs;
}
var relocate=(b, cell)=>tagOf(cell) < 3 ? cell + b : cell
var array_last=(a, def)=>a.length ? a[a.length - 1] : def
var hasClauses=S=>S.k < S.cs.length
var hasGoals=(S)=>S.gs.length > 0

function Prog(s) {
    this.ppCode=()=>{
        pp("\nSYMS:")
        pp(this.syms)
        pp("\nCLAUSES:\n")
        for (var i = 0; i < this.clauses.length; i++) {
            var C = this.clauses[i]
            pp("[" + i + "]:" + this.showClause(C))
        }
        pp("")
    }
    this.showClause=(s)=>{
        var r = ''
        var l = s.hgs.length
        r += "---base:[" + s.base + "] neck: " + s.neck + "-----\n"
        r += this.showCells2(s.base, s.len); // TODO
        r += "\n"
        r += this.showCell(s.hgs[0])

        r += " :- ["
        for (var i = 1; i < l; i++) {
            var e = s.hgs[i]
            r += this.showCell(e)
            if (i < l - 1)
                r += ", "
        }

        r += "]\n"

        r += this.showTerm(s.hgs[0])
        if (l > 1) {
            r += " :- \n"
            for (var i = 1; i < l; i++) {
                var e = s.hgs[i]
                r += "  "
                r += this.showTerm(e)
                r += "\n"
            }
        } else {
            r += "\n"
        }
        return r
    }
    
    this.showTerm=(O)=>
        typeof O === 'number' ? Engine.prototype.showTerm.call(this, O)
        : O instanceof Array ? st0(O)
        : JSON.stringify(O)
        
    this.ppGoals=bs=>{
        while (bs.length) {
            pp(this.showTerm(bs[0]))
            bs = bs.slice(1);
        }
    }
    this.ppc=S=>{
        var bs = S.gs
        pp("\nppc: t=" + S.ttop + ",k=" + S.k + "len=" + bs.length)
        this.ppGoals(bs)
    }

    Engine.call(this, s)
}
Prog.prototype = Object.create(Engine.prototype)

var maybeNull=(O)=>{
    if (null == O)
        return "$null"
    if (O instanceof Array)
        return st0(O)
    return ''+O
}
var isListCons=(name)=>"." === name || "[|]" === name || "list" === name
var isOp=(name)=>"/" === name || "-" === name || "+" === name || "=" === name
var st0=(args)=>{
    var r = ''
    var name = ''+args[0]
    if (args.length == 3 && isOp(name)) {
        r += "("
        r += maybeNull(args[0])
        r += " " + name + " "
        r += maybeNull(args[1])
        r += ")"
    } else if (args.length == 3 && isListCons(name)) {
        r += '['
        r += maybeNull(args[1])
        var tail = args[2]
        for (;;) {
            if ("[]" === tail || "nil" === tail) {
                break
            }
            if (!(tail instanceof Array)) {
                r += '|'
                r += maybeNull(tail)
                break
            }
            var list = tail
            if (!(list.length == 3 && isListCons(list[0]))) {
                r += '|'
                r += maybeNull(tail)
                break
            } else {
                r += ','
                r += maybeNull(list[1])
                tail = list[2]
            }
        }
        r += ']'
    } else if (args.length == 2 && "$VAR" === name) {
        r += "_" + args[1]
    } else {
        var qname = maybeNull(args[0])
        r += qname
        r += "("
        for (var i = 1; i < args.length; i++) {
            var O = args[i]
            r += maybeNull(O)
            if (i < args.length - 1) {
                r += ","
            }
        }
        r += ")"
    }
    return r
}

context.Toks = Toks // for initial debugging
context.Engine = Engine
context.Prog = Prog

})(typeof module !== 'undefined' ? module.exports : self);
