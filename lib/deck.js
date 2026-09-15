/* The status deck, shared by the two things that make it.

   The Export deck button in index.html loads this file with a script tag, and
   the morning email (api/daily-brief.js) imports it, so the deck someone
   exports and the deck that arrives at 7am are built by the same code and
   cannot drift apart. It is plain ES5 with no module syntax so that both can
   load it, and it hangs a single object, BMVDeck, on the global.

   A .pptx is a ZIP of XML parts, exactly as an .xlsx is, so the ZIP writer
   lives here too and the Excel export borrows it. Every shape is absolutely
   positioned, which is what PowerPoint stores natively, so nothing here needs
   a layout engine: dkLines() only estimates how tall a table row must be, and
   PowerPoint still does the real wrapping inside it.

   No images. Each part is encoded as UTF-8 text, so a PNG cannot go through,
   and carrying the artwork would mean base64 in the page for every reader on
   every load. The brand is drawn instead. */
(function(root){
  "use strict";

  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){
    return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
  /* esc() emits only entities that are also legal XML. Control characters are
     not, and a single one makes PowerPoint or Excel reject the whole file. */
  function xesc(s){ return esc(String(s==null?"":s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,"")); }

  var PRI_ORDER={"Immediate":0,"Near-Term":1,"Postponed":2,"No Action":3};
  function priRank(c){ return PRI_ORDER[c.priority]!=null?PRI_ORDER[c.priority]:9; }

  /* ---------- next actions ----------
     The app uses these for its tick boxes as well, so there is one copy of the
     rule for who owns a line. */
  function actionLines(c){
    return String((c&&c.nextAction)||"").split("\n")
      .map(function(l){ return l.trim(); }).filter(Boolean);
  }
  /* An action line may name who owns it: "Mina: draft the notice", or
     "Reem, Rafik: decide the follow-on". Only a prefix made entirely of known
     names counts, so "Note: ..." and "Follow up ... on 23 August: statements"
     are left alone. The brief reads the same tags to build its desks. */
  var PEOPLE=["Mina","Rafik","Reem"];
  /* Any common bullet, so "*Reem: ..." still finds Reem. The letter o counts
     only with a space after it (Word's sub-bullet), never as the first letter
     of "Obtain". Same rule as toLines() in the brief. */
  var BULLET=/^(?:[\u2022\-*\u00b7\u25aa\u2023\u2013]|o(?=\s))\s*/;
  function parseAction(line){
    var t=String(line).replace(BULLET,"").trim();
    var m=/^([^:]{1,60}):\s*(.+)$/.exec(t);
    if(m){
      var raw=m[1].split(/,|&|\band\b/).map(function(x){ return x.trim(); }).filter(Boolean);
      var named=raw.map(function(x){
        return PEOPLE.filter(function(p){ return p.toLowerCase()===x.toLowerCase(); })[0];
      }).filter(Boolean);
      if(named.length && named.length===raw.length) return {owners:named, text:m[2].trim()};
    }
    return {owners:[], text:t};
  }

  /* ---------- zip ---------- */
  var CRC_T=(function(){ var t=[],c,n,k;
    for(n=0;n<256;n++){ c=n; for(k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[n]=c>>>0; }
    return t; })();
  function crc32(b){ var c=0xFFFFFFFF;
    for(var i=0;i<b.length;i++) c=CRC_T[(c^b[i])&0xFF]^(c>>>8);
    return (c^0xFFFFFFFF)>>>0; }

  /* Entries are stored uncompressed, so this needs only a CRC32. Returns the
     bytes: the page wraps them in a Blob, the email base64-encodes them. */
  function zip(files){
    var enc=new TextEncoder(), parts=[], central=[], off=0;
    function u16(n){ return [n&0xFF,(n>>>8)&0xFF]; }
    function u32(n){ return [n&0xFF,(n>>>8)&0xFF,(n>>>16)&0xFF,(n>>>24)&0xFF]; }
    files.forEach(function(f){
      var name=enc.encode(f.name), data=enc.encode(f.xml), crc=crc32(data);
      var loc=[].concat(u32(0x04034b50),u16(20),u16(0x0800),u16(0),u16(0),u16(0),
        u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0));
      parts.push(new Uint8Array(loc), name, data);
      central.push([].concat(u32(0x02014b50),u16(20),u16(20),u16(0x0800),u16(0),u16(0),u16(0),
        u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),
        u32(0),u32(off)), name);
      off += loc.length + name.length + data.length;
    });
    var cd=[], cdLen=0;
    for(var i=0;i<central.length;i+=2){
      var h=new Uint8Array(central[i]); cd.push(h, central[i+1]); cdLen += h.length + central[i+1].length;
    }
    var end=new Uint8Array([].concat(u32(0x06054b50),u16(0),u16(0),
      u16(files.length),u16(files.length),u32(cdLen),u32(off),u16(0)));
    var all=parts.concat(cd,[end]), size=0, at=0;
    all.forEach(function(a){ size+=a.length; });
    var bytes=new Uint8Array(size);
    all.forEach(function(a){ bytes.set(a,at); at+=a.length; });
    return bytes;
  }

  /* ---------- deck ---------- */
  var DK_W=10689336, DK_H=7562088;               /* A4 landscape, in EMU */
  var DKC={ maroon:"801A37", tan:"BA7334", gold:"EDAD3A", sand:"DAC299",
            stone:"8C8C86", grey:"9A9A95", ink:"1A1A1A", cream:"F5EDE2",
            rule:"E7DFD2", muted:"5B5B5B", dim:"C9C6C0", white:"FFFFFF",
            blush:"F2E4E9" };
  var DK_PRI_DOT={ "Immediate":DKC.maroon, "Near-Term":DKC.tan,
                   "Postponed":DKC.sand, "No Action":DKC.grey };
  /* The five channels a company can be waiting on, in the deck's order. */
  var DK_DEPS=["Founders / Company","Legal Counsel","Internal — ISV / Board",
               "No Dependency","Co-Investor (Misr Capital)"];
  function dkEmu(i){ return Math.round(i*914400); }
  function dkRun(t,sz,o){
    o=o||{};
    return '<a:r><a:rPr lang="en-US" sz="'+Math.round(sz*100)+'"'+(o.b?' b="1"':'')+
      '><a:solidFill><a:srgbClr val="'+(o.c||DKC.ink)+'"/></a:solidFill>'+
      '<a:latin typeface="'+(o.f||"Calibri")+'"/></a:rPr><a:t>'+xesc(t)+'</a:t></a:r>';
  }
  var dkSeq=0;
  function dkSp(o){
    /* o.paras is a list of run-lists, one paragraph each; o.runs is one. */
    var paras=o.paras || ((o.runs&&o.runs.length) ? [o.runs] : null);
    /* o.bullet: PowerPoint's own bullet with a hanging indent, so a wrapped
       second line lines up under the text rather than under the dot. */
    var ind=dkEmu(DK_BULLET_IN);
    var body=paras
      ? paras.map(function(r,i){
          return '<a:p><a:pPr'+(o.bullet?' marL="'+ind+'" indent="-'+ind+'"':'')+
            (o.align?' algn="'+o.align+'"':'')+'>'+
            (o.line?'<a:lnSpc><a:spcPct val="'+Math.round(o.line*100000)+'"/></a:lnSpc>':'')+
            (i&&o.gap?'<a:spcBef><a:spcPts val="'+Math.round(o.gap*100)+'"/></a:spcBef>':'')+
            (o.bullet?'<a:buFont typeface="Arial"/><a:buChar char="\u2022"/>':'')+
            '</a:pPr>'+r.join("")+'</a:p>'; }).join("")
      : '<a:p><a:endParaRPr lang="en-US"/></a:p>';
    dkSeq++;
    return '<p:sp><p:nvSpPr><p:cNvPr id="'+(dkSeq+1)+'" name="sh'+dkSeq+'"/>'+
      '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>'+
      '<a:xfrm><a:off x="'+dkEmu(o.x)+'" y="'+dkEmu(o.y)+'"/>'+
      '<a:ext cx="'+dkEmu(o.w)+'" cy="'+dkEmu(o.h)+'"/></a:xfrm>'+
      '<a:prstGeom prst="'+(o.geom||"rect")+'"><a:avLst/></a:prstGeom>'+
      (o.fill?'<a:solidFill><a:srgbClr val="'+o.fill+'"/></a:solidFill>':'<a:noFill/>')+
      '</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"'+
      ' anchor="'+(o.anchor||"t")+'"><a:noAutofit/></a:bodyPr><a:lstStyle/>'+
      body+'</p:txBody></p:sp>';
  }
  /* Only used to size a row band. Calibri averages about .48em per character,
     which is close enough to pick a line count; PowerPoint wraps for real. */
  function dkLines(text,inches,pt){
    var cpl=Math.max(8, Math.floor(inches/(pt*0.48/72)));
    var w=String(text||"").split(/\s+/).filter(Boolean), n=1, len=0;
    for(var i=0;i<w.length;i++){
      var add=(len?1:0)+w[i].length;
      if(len+add>cpl && len){ n++; len=w[i].length; } else len+=add;
    }
    return n;
  }
  var DK_MONTHS=["January","February","March","April","May","June","July","August",
                 "September","October","November","December"];
  /* The Export button's deck is dated by month. The morning email's is dated
     by day, since a month of them would otherwise share one cover. */
  function dkCoverDate(ymd, byDay){
    var t=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd||"")) ||
          /^(\d{4})-(\d{2})-(\d{2})/.exec(new Date().toISOString());
    return (byDay ? (+t[3])+" " : "")+DK_MONTHS[(+t[2])-1]+" "+t[1];
  }
  function dkBrand(){ return dkSp({x:0.55,y:0.45,w:0.08,h:0.62,fill:DKC.maroon}); }
  function dkHead(title,sub){
    return dkSp({x:1.30,y:0.42,w:9.84,h:0.50,
      runs:[dkRun(title,21,{b:true}), dkRun("   "+sub,12.5,{c:DKC.muted})]});
  }
  function dkFooter(n){
    return dkSp({x:6.94,y:7.68,w:4.00,h:0.30,align:"r",
      runs:[dkRun("Legal, Investment & Value Creation"+(n?"   "+n:""),11,{b:true})]});
  }
  function dkSlide(shapes){
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '+
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '+
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'+
      '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/>'+
      '<p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/>'+
      '<a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/>'+
      '</a:xfrm></p:grpSpPr>'+shapes.join("")+'</p:spTree></p:cSld>'+
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  }

  /* Tables are set at a fixed size -- 10pt, company names 11pt -- chosen for
     legibility, and paginated rather than shrunk: a table that will not fit
     carries on to another slide, splitting only between rows and repeating its
     header. An earlier version shrank the type until everything fitted on one
     slide, which put twelve companies at 7pt. Row heights come from an estimate
     of how many lines each cell wraps to; PowerPoint does the real wrapping. */
  var DK_X=0.55, DK_TW=10.59, DK_HEAD=1.40, DK_HEAD_H=0.38, DK_TOP=1.80, DK_BOTTOM=7.56;
  var DK_PT=10, DK_PAD=0.10, DK_BULLET_IN=0.15;
  function dkCellH(paras,col){
    var size=col.big?DK_PT+1:DK_PT;
    var width=col.w-2*DK_PAD-(col.dot?0.18:0)-(col.bullet?DK_BULLET_IN:0);
    var lines=paras.reduce(function(n,p){ return n+dkLines(p,width,size*1.08); },0);
    return lines*size*1.2/72 + Math.max(0,paras.length-1)*3/72;
  }
  function dkRowH(r,cols){
    var most=0;
    r.cells.forEach(function(paras,j){ most=Math.max(most, dkCellH(paras,cols[j])); });
    return Math.max(0.40, most+0.32);
  }
  /* As few slides as the rows need, then balanced across them, so a second
     slide never holds a single straggling row. It finds the smallest page
     capacity that still needs no more slides, and packs to that. */
  function dkPages(hs,avail){
    var count=function(cap){ var n=1,u=0;
      hs.forEach(function(h){ if(u && u+h>cap){ n++; u=0; } u+=h; }); return n; };
    var tallest=hs.length ? Math.max.apply(null,hs) : 0;
    var hi=Math.max(avail,tallest), k=count(hi), lo=tallest;
    for(var i=0;i<40;i++){ var mid=(lo+hi)/2; if(count(mid)<=k) hi=mid; else lo=mid; }
    var pages=[[]], u=0;
    hs.forEach(function(h,idx){
      if(u && u+h>hi+1e-6){ pages.push([]); u=0; }
      pages[pages.length-1].push(idx); u+=h;
    });
    return pages;
  }
  /* Returns one slide's worth of shapes per page the table needs. */
  function dkTables(spec){
    var cols=spec.cols, xs=[], x=DK_X;
    cols.forEach(function(c){ xs.push(x); x+=c.w; });
    var hs=spec.rows.map(function(r){ return dkRowH(r,cols); });
    var pages=dkPages(hs, DK_BOTTOM-DK_TOP);
    return pages.map(function(idxs,pi){
      var sh=[dkBrand(),
        dkHead(spec.title, spec.sub+(pages.length>1 ? "  |  "+(pi+1)+" of "+pages.length : "")),
        dkSp({x:DK_X,y:DK_HEAD,w:DK_TW,h:DK_HEAD_H,fill:DKC.ink})];
      cols.forEach(function(c,j){
        sh.push(dkSp({x:xs[j]+DK_PAD,y:DK_HEAD,w:c.w-2*DK_PAD,h:DK_HEAD_H,anchor:"ctr",
          runs:[dkRun(c.h,9,{b:true,c:DKC.gold})]}));
      });
      var y=DK_TOP;
      idxs.forEach(function(ri,i){
        var r=spec.rows[ri], h=hs[ri];
        if(i%2===1) sh.push(dkSp({x:DK_X,y:y,w:DK_TW,h:h,fill:DKC.cream}));
        r.cells.forEach(function(paras,j){
          if(!paras.length) return;
          var c=cols[j], size=c.big?DK_PT+1:DK_PT, ox=c.dot?0.18:0;
          if(c.dot) sh.push(dkSp({x:xs[j]+DK_PAD, y:y+0.12+size*0.6/72-0.05, w:0.10, h:0.10,
                                  geom:"ellipse", fill:r.dot||DKC.grey}));
          sh.push(dkSp({x:xs[j]+DK_PAD+ox, y:y+0.12, w:c.w-2*DK_PAD-ox, h:h-0.14, gap:3,
            bullet:!!c.bullet,
            paras:paras.map(function(t){
              return [dkRun(t,size,{b:!!c.big,c:c.colour||DKC.ink})]; })}));
        });
        y+=h;
      });
      /* A table with nothing in it says so, rather than a header over nothing. */
      if(!idxs.length){
        sh.push(dkSp({x:DK_X+DK_PAD,y:y+0.12,w:DK_TW-2*DK_PAD,h:0.30,
          runs:[dkRun(spec.empty||"Nothing to show.",DK_PT,{c:DKC.muted})]}));
        y+=0.50;
      }
      /* faint rules down the columns and one to close the table */
      for(var j=1;j<cols.length;j++)
        sh.push(dkSp({x:xs[j]-0.005,y:DK_TOP,w:0.01,h:y-DK_TOP,fill:DKC.rule}));
      sh.push(dkSp({x:DK_X,y:y,w:DK_TW,h:0.015,fill:DKC.rule}));
      if(spec.note && pi===pages.length-1)
        sh.push(dkSp({x:DK_X,y:7.70,w:6.2,h:0.26,runs:[dkRun(spec.note,8,{c:DKC.muted})]}));
      sh.push(dkFooter(spec.firstPage+pi));
      return sh;
    });
  }

  /* Who does each action line belong to: its own tag, else the company's owner
     when the owner is one of the three. Same rule the brief uses for its desks. */
  var DK_MAP_PEOPLE=["Reem","Mina","Rafik"];
  function dkActionsByPerson(c){
    var out={Reem:[],Mina:[],Rafik:[]}, unowned=0;
    var own=PEOPLE.filter(function(p){
      return p.toLowerCase()===String(c.owner||"").trim().toLowerCase(); })[0];
    actionLines(c).forEach(function(line){
      var a=parseAction(line);
      if(!a.text) return;
      var who=a.owners.length ? a.owners : (own ? [own] : []);
      if(!who.length){ unowned++; return; }
      who.forEach(function(p){ out[p].push(a.text); });
    });
    return {byPerson:out, unowned:unowned};
  }

  /* companies are the app's camelCase rows. opts, all optional:
       date    "YYYY-MM-DD" for the cover, defaulting to today
       byDay   date the cover by day rather than by month
       moved   {sub, rows:[{company, date, entry}], note} adds a WHAT
               MOVED slide at the end. The morning email passes it; the Export
               button does not, so the weekly deck stays a cover and two tables. */
  function deckSlides(companies, opts){
    opts=opts||{};
    var rows=(companies||[]).filter(Boolean).slice().sort(function(a,b){
      return (priRank(a)-priRank(b)) ||
             String(a.company).localeCompare(String(b.company)); });
    var S=[], n=rows.length, plural=function(k,w){ return k+" "+w+(k===1?"":"s"); };
    var coverDate=dkCoverDate(opts.date, opts.byDay);

    /* cover */
    S.push(dkSlide([
      dkSp({x:0,y:0,w:7.05,h:8.27,fill:DKC.maroon}),
      dkSp({x:2.75,y:3.55,w:8.40,h:2.35,fill:DKC.ink}),
      dkSp({x:3.20,y:3.90,w:7.60,h:1.05,
            runs:[dkRun("Portfolio Status Update",32,{b:true,c:DKC.white})]}),
      dkSp({x:3.20,y:5.05,w:7.60,h:0.45,
            runs:[dkRun(coverDate+"  |  Legal, Investment & Value Creation",14,
                        {c:DKC.blush})]}),
      dkSp({x:7.15,y:7.85,w:3.99,h:0.30,align:"r",
            runs:[dkRun("Legal, Investment & Value Creation",11,{b:true})]})
    ]));

    /* detailed status, with the targeted outcome. That is the tracker's
       Strategic Target, which is the `closure` column. */
    var status=dkTables({
      title:"DETAILED STATUS",
      sub:"Issue, latest status and targeted outcome  |  "+plural(n,"item"),
      firstPage:2,
      cols:[{h:"COMPANY",w:1.45,big:true,colour:DKC.maroon},
            {h:"PRIORITY",w:1.15,dot:true},
            {h:"ISSUE CURRENTLY ADDRESSED",w:2.35},
            {h:"LATEST STATUS",w:3.00,colour:DKC.muted},
            {h:"TARGETED OUTCOME",w:2.64}],
      rows:rows.map(function(c){
        return {dot:DK_PRI_DOT[c.priority]||DKC.grey,
                cells:[dkText(c.company), dkText(c.priority), dkText(c.issueTitle),
                       dkText(c.latestStatus), dkText(c.closure)]}; }),
      empty:"No companies in the tracker."
    });
    status.forEach(function(sh){ S.push(dkSlide(sh)); });

    /* action map: a row per company that has any action, a column per person.
       A company nobody has an action on is left out, as it is in the brief. */
    var unowned=0, mapRows=[];
    rows.forEach(function(c){
      var a=dkActionsByPerson(c);
      unowned+=a.unowned;
      if(!DK_MAP_PEOPLE.some(function(p){ return a.byPerson[p].length; })) return;
      mapRows.push({cells:[dkText(c.company)].concat(
        DK_MAP_PEOPLE.map(function(p){ return a.byPerson[p]; }))});
    });
    var map=dkTables({
      title:"ACTION MAP",
      sub:"Who owns each next action  |  "+mapRows.length+(mapRows.length===1?" company":" companies"),
      firstPage:2+status.length,
      cols:[{h:"COMPANY",w:1.45,big:true,colour:DKC.maroon},
            {h:"REEM",w:3.05,bullet:true},{h:"MINA",w:3.05,bullet:true},
            {h:"RAFIK",w:3.04,bullet:true}],
      rows:mapRows,
      empty:"No next actions are recorded.",
      /* never silent: an action with no owner is named, not dropped quietly */
      note: unowned ? plural(unowned,"action line")+" in the tracker "+
                      (unowned===1?"has":"have")+" no owner and "+(unowned===1?"is":"are")+" not shown." : ""
    });
    map.forEach(function(sh){ S.push(dkSlide(sh)); });

    /* what moved: the annex. The history log fills itself as the team works,
       where LATEST STATUS is typed by hand, so this is the slide that still
       changes on a morning nobody edited the tracker. */
    var mv=opts.moved;
    if(mv && ((mv.rows&&mv.rows.length) || mv.note)){
      dkTables({
        title:"WHAT MOVED",
        sub:mv.sub||"",
        firstPage:2+status.length+map.length,
        /* No source column: it said "Email" or "Internal update", which is
           not what anyone reads this slide for, and it took the width the
           entry needs. */
        cols:[{h:"COMPANY",w:1.45,big:true,colour:DKC.maroon},
              {h:"DATE",w:1.00,colour:DKC.muted},
              {h:"WHAT MOVED",w:8.14}],
        rows:(mv.rows||[]).filter(Boolean).map(function(h){
          return {cells:[dkText(h.company), dkText(h.date), dkLinesOf(h.entry)]}; }),
        empty:"Nothing logged beyond the actions ticked off below.",
        note:mv.note||""
      }).forEach(function(sh){ S.push(dkSlide(sh)); });
    }
    return S;
  }
  /* A cell is a list of paragraphs: one for a plain field, one per line for
     a history entry, with whatever bullet was typed taken off. */
  function dkText(v){ v=String(v==null?"":v).trim(); return v?[v]:[]; }
  function dkLinesOf(v){
    return String(v==null?"":v).split("\n")
      .map(function(l){ return l.replace(BULLET,"").trim(); }).filter(Boolean);
  }

  function buildPptx(slides){
    var NS_R="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    var rel=function(id,type,tgt){
      return '<Relationship Id="'+id+'" Type="'+NS_R+'/'+type+'" Target="'+tgt+'"/>'; };
    var rels=function(body){
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
        body+'</Relationships>'; };
    var P="application/vnd.openxmlformats-officedocument.presentationml";
    var files=[
      {name:"[Content_Types].xml", xml:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
        '<Default Extension="xml" ContentType="application/xml"/>'+
        '<Override PartName="/ppt/presentation.xml" ContentType="'+P+'.presentation.main+xml"/>'+
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="'+P+'.slideMaster+xml"/>'+
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="'+P+'.slideLayout+xml"/>'+
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'+
        slides.map(function(_,i){ return '<Override PartName="/ppt/slides/slide'+(i+1)+
          '.xml" ContentType="'+P+'.slide+xml"/>'; }).join("")+'</Types>'},
      {name:"_rels/.rels", xml:rels(rel("rId1","officeDocument","ppt/presentation.xml"))},
      {name:"ppt/presentation.xml", xml:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '+
        'xmlns:r="'+NS_R+'" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'+
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'+
        '<p:sldIdLst>'+slides.map(function(_,i){
          return '<p:sldId id="'+(256+i)+'" r:id="rId'+(i+2)+'"/>'; }).join("")+'</p:sldIdLst>'+
        '<p:sldSz cx="'+DK_W+'" cy="'+DK_H+'"/><p:notesSz cx="'+DK_H+'" cy="'+DK_W+'"/>'+
        '</p:presentation>'},
      {name:"ppt/_rels/presentation.xml.rels", xml:rels(
        rel("rId1","slideMaster","slideMasters/slideMaster1.xml")+
        slides.map(function(_,i){
          return rel("rId"+(i+2),"slide","slides/slide"+(i+1)+".xml"); }).join(""))},
      {name:"ppt/slideMasters/slideMaster1.xml",
       xml:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
        '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '+
        'xmlns:r="'+NS_R+'" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'+
        '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>'+
        '<a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/>'+
        '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>'+
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" '+
        'accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" '+
        'accent6="accent6" hlink="hlink" folHlink="folHlink"/>'+
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'+
        '</p:sldMaster>'},
      {name:"ppt/slideMasters/_rels/slideMaster1.xml.rels", xml:rels(
        rel("rId1","slideLayout","../slideLayouts/slideLayout1.xml")+
        rel("rId2","theme","../theme/theme1.xml"))},
      {name:"ppt/slideLayouts/slideLayout1.xml",
       xml:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
        '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '+
        'xmlns:r="'+NS_R+'" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '+
        'type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr>'+
        '<p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'+
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'},
      {name:"ppt/slideLayouts/_rels/slideLayout1.xml.rels", xml:rels(
        rel("rId1","slideMaster","../slideMasters/slideMaster1.xml"))},
      {name:"ppt/theme/theme1.xml", xml:dkTheme()}
    ];
    slides.forEach(function(x,i){
      files.push({name:"ppt/slides/slide"+(i+1)+".xml", xml:x});
      files.push({name:"ppt/slides/_rels/slide"+(i+1)+".xml.rels", xml:rels(
        rel("rId1","slideLayout","../slideLayouts/slideLayout1.xml"))});
    });
    return zip(files);
  }

  /* A theme is not optional: PowerPoint refuses a deck without one. The lists
     inside fmtScheme must each carry exactly three entries. */
  function dkTheme(){
    var f='<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
    var ln='<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">'+f+
           '<a:prstDash val="solid"/></a:ln>';
    var ef='<a:effectStyle><a:effectLst/></a:effectStyle>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="BMV">'+
      '<a:themeElements><a:clrScheme name="BMV">'+
      '<a:dk1><a:srgbClr val="'+DKC.ink+'"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'+
      '<a:dk2><a:srgbClr val="'+DKC.maroon+'"/></a:dk2>'+
      '<a:lt2><a:srgbClr val="'+DKC.cream+'"/></a:lt2>'+
      '<a:accent1><a:srgbClr val="'+DKC.maroon+'"/></a:accent1>'+
      '<a:accent2><a:srgbClr val="'+DKC.tan+'"/></a:accent2>'+
      '<a:accent3><a:srgbClr val="'+DKC.gold+'"/></a:accent3>'+
      '<a:accent4><a:srgbClr val="'+DKC.sand+'"/></a:accent4>'+
      '<a:accent5><a:srgbClr val="'+DKC.stone+'"/></a:accent5>'+
      '<a:accent6><a:srgbClr val="'+DKC.muted+'"/></a:accent6>'+
      '<a:hlink><a:srgbClr val="'+DKC.maroon+'"/></a:hlink>'+
      '<a:folHlink><a:srgbClr val="'+DKC.muted+'"/></a:folHlink></a:clrScheme>'+
      '<a:fontScheme name="BMV">'+
      '<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'+
      '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>'+
      '</a:fontScheme><a:fmtScheme name="BMV">'+
      '<a:fillStyleLst>'+f+f+f+'</a:fillStyleLst>'+
      '<a:lnStyleLst>'+ln+ln+ln+'</a:lnStyleLst>'+
      '<a:effectStyleLst>'+ef+ef+ef+'</a:effectStyleLst>'+
      '<a:bgFillStyleLst>'+f+f+f+'</a:bgFillStyleLst>'+
      '</a:fmtScheme></a:themeElements></a:theme>';
  }

  root.BMVDeck={
    /* the deck: .pptx bytes, and the slide XML behind them for tests */
    build:function(companies, opts){ dkSeq=0; return buildPptx(deckSlides(companies, opts)); },
    slides:function(companies, opts){ dkSeq=0; return deckSlides(companies, opts); },
    MIME:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    /* shared with the app */
    zip:zip, xesc:xesc, actionLines:actionLines, parseAction:parseAction,
    PEOPLE:PEOPLE, BULLET:BULLET, PRI_ORDER:PRI_ORDER, DEPS:DK_DEPS,
    /* exposed for tests */
    actionsByPerson:dkActionsByPerson, pages:dkPages, BOTTOM:DK_BOTTOM
  };
})(typeof globalThis!=="undefined"?globalThis:window);
