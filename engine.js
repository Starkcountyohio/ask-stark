/* ============================================================================
 * Ask Stark -- deterministic engine (browser + Node).
 *
 * The data-facing core, kept separate from the UI and the network call so it can
 * be tested directly (test_engine.mjs runs it under sql.js in Node) and so the
 * language model -- which lives in index.html and only maps questions to a metric
 * -- can never touch the data or write SQL. Mirrors the Python engine.py/catalog.py.
 *
 * Exposed as AskStarkEngine (window in the browser, module.exports in Node).
 * Call setDb(sqlJsDatabase) once before use.
 * ========================================================================== */
(function(){
"use strict";

let db = null;
let coverageCache = {};
function setDb(database){ db = database; coverageCache = {}; }

// ---- Curated vocabularies (stable sets; mirror catalog.py) ----------------
const TOWNSHIPS = ["JACKSON TWP","PLAIN TWP","PERRY TWP","LAKE TWP","CANTON TWP",
  "NIMISHILLEN TWP","SUGARCREEK TWP","LAWRENCE TWP","BETHLEHEM TWP","OSNABURG TWP",
  "TUSCARAWAS TWP","LEXINGTON TWP","PARIS TWP","WASHINGTON TWP","MARLBORO TWP",
  "SANDY TWP","PIKE TWP"];
const SCHOOL_DISTRICTS = ["ALLIANCE CSD","BROWN LSD","CANTON CSD","CANTON LSD",
  "FAIRLESS LSD","JACKSON LSD","LAKE LSD","LOUISVILLE CSD","MARLINGTON LSD",
  "MASSILLON CSD","MINERVA LSD","NORTH CANTON CSD","NORTHWEST LSD","OSNABURG LSD",
  "PERRY LSD","PLAIN LSD","SANDY VALLEY LSD","SOUTHEAST LSD","TUSCARAWAS VALLEY LSD",
  "TUSLAW LSD"];
const RES_WORK = ["R_SIN","R_DUP","R_APT","R_CON","R_TOWN","R-MOB","R_OTH"];
// Deed / instrument types (SALES.INSTRTYP office labels; the store decodes to these).
const DEED_TYPES = ["Affidavit of Confirmation","Administrator's Deed","Affidavit",
  "Affidavit Relating to Title","Auditor's Deed","Re-Recorded/Corrected Deed",
  "Commissioner's Deed","Certificate of Transfer","Deed (by Power of Attorney)",
  "Executor's Deed","Fiduciary Deed","Guardian's Deed","Governor's Deed",
  "Judgement Entry","Limited (Specialty) Warranty Deed","Marshall's Deed",
  "Manufactured Home Conveyance","Deed (various types)","Private Selling Officer's Deed",
  "Quit Claim Deed","Receiver's Deed","Sheriff's Deed","Survivorship Deed",
  "Trustee's Deed","General Warranty Deed"];

// Free-text filters validated against a store column: param -> [table, column, label]
const TEXT_DOMAINS = {
  city:            ["homestead","situs_city","city"],
  township:        ["property_values","township","township"],
  school_district: ["property_values","school_district","school district"],
  grade:           ["dwelling","grade","grade"],
  style:           ["dwelling","style","home style"],
  neighborhood:    ["property_values","nbhd","neighborhood"],
  exterior_wall:   ["dwelling","exterior_wall","exterior wall"],
  basement:        ["dwelling","basement","basement type"],
  central_air:     ["dwelling","central_air","central air"],
  heating_fuel:    ["dwelling","heating_fuel","heating fuel"],
  condition:       ["dwelling","condition","condition"],
  basement_finish: ["dwelling","basement_finish","basement finish"],
  deed_type:       ["property_sales","deed_type","deed type"]
};

const REFERRALS = {
  property_lookup:{label:"Look up a specific property",
    message:"For details about one specific property -- owner, value, sale history, taxes -- use the Auditor's Real Estate Search.",
    url:"https://realestate.starkcountyohio.gov/Search/Disclaimer.aspx?FromUrl=../search/commonsearch.aspx?mode=realprop"},
  treasurer:{label:"Stark County Treasurer",
    message:"Tax collection -- the official delinquent tax list, payments, payment plans, and due dates -- is handled by the Stark County Treasurer, not the Auditor.",
    url:"https://www.starkcountyohio.gov/government/offices/treasurer/index.php"}
};

// ---- SQLite helpers --------------------------------------------------------
function queryRow(sql, binds){
  const s=db.prepare(sql); s.bind(binds||{}); let r=null;
  if(s.step()) r=s.getAsObject(); s.free(); return r;
}
function queryCol(sql, binds){
  const s=db.prepare(sql); s.bind(binds||{}); const out=[];
  while(s.step()){ out.push(Object.values(s.getAsObject())[0]); } s.free(); return out;
}
function coverage(table){
  if(coverageCache[table]) return coverageCache[table];
  const r=queryRow("select min_year,max_year,refreshed_at from refresh_meta where table_name=:t",{":t":table});
  coverageCache[table]=r; return r;
}
function refreshedAt(){ return queryRow("select max(refreshed_at) as ts from refresh_meta")?.ts || "unknown"; }
function fmt(n){ return (n==null)?"" : Number(n).toLocaleString("en-US"); }

// ---- Deterministic filter builders (mirror catalog.py) ---------------------
function resolveYear(value, cov){
  const lo=cov.min_year, hi=cov.max_year;
  if(value==null || value==="latest") return hi;
  const y=parseInt(value,10);
  if(y<lo || y>hi) throw {oor:true, msg:`the store holds ${lo}-${hi} for this metric; ${y} is not available`};
  return y;
}
function applyText(params, key, col, where, binds, chosen){
  let v=params[key]; v=(typeof v==="string")?v.trim():"";
  if(v && !["all","unspecified"].includes(v.toLowerCase())){
    where.push(`upper(${col}) = :${key}`); binds[":"+key]=v.toUpperCase(); chosen[key]=v.toUpperCase();
  } else { chosen[key]="all"; }
}
function applyGeo(params, where, binds, chosen){
  applyText(params,"city","situs_city",where,binds,chosen);
  applyText(params,"township","township",where,binds,chosen);
  applyText(params,"school_district","school_district",where,binds,chosen);
}
function medianExpr(col, table, whereSql){
  const cond=`${whereSql} and ${col} is not null`;
  const base=`select ${col} from ${table} where ${cond}`;
  const cnt=`select count(*) from ${table} where ${cond}`;
  return `(select avg(${col}) from (${base} order by ${col} limit 2 - (${cnt}) % 2 offset ((${cnt}) - 1) / 2))`;
}

// ---- The catalog: metric definitions + SQL builders ------------------------
const METRICS = {
  homestead_exemptions:{
    label:"Homestead exemptions", table:"homestead", unit:"parcels",
    description:"Count of parcels receiving the homestead exemption in a tax year, with the total and average reduction in taxable value.",
    provenance:"Aggregate counts only -- no recipient name, date of birth, or address is stored. Homestead-code tiers use the Auditor's office crosswalk.",
    build(p,cov){
      const year=resolveYear(p.year,cov); const tier=(p.tier||"all").toLowerCase();
      const where=["tax_year = :year"]; const binds={":year":year}; const chosen={year,tier};
      if(tier==="standard") where.push("homestead_code in ('H','D','S')");
      else if(tier==="enhanced") where.push("homestead_code in ('V','W','P')");
      applyGeo(p,where,binds,chosen);
      const sql=`select count(*) as parcels, round(coalesce(sum(reduction_total),0)) as total_reduction, round(coalesce(avg(reduction_total),0)) as avg_reduction from homestead where ${where.join(" and ")}`;
      return {sql,binds,chosen};
    },
    headline(r){return [`${fmt(r.parcels)} parcels`,
      `$${fmt(r.total_reduction)} total reduction in taxable value`,
      `$${fmt(r.avg_reduction)} average reduction per parcel`];}
  },
  delinquent_balances:{
    label:"Delinquent tax balances (current)", table:"delinquency", unit:"parcels",
    description:"Parcels with a current unpaid real-property tax balance, and the total owed, for the certified years the store holds.",
    provenance:"A CURRENT snapshot, not the list as published in a past year. Vacant land is approximated by land-use code. For the official delinquent list, see the Treasurer.",
    build(p,cov){
      const year=resolveYear(p.year,cov); const vacant=(p.vacant||"include").toLowerCase();
      const where=["tax_year = :year"]; const binds={":year":year}; const chosen={year,vacant};
      if(vacant==="exclude") where.push("vacant_flag = 0");
      else if(vacant==="only") where.push("vacant_flag = 1");
      applyGeo(p,where,binds,chosen);
      const sql=`select count(*) as parcels, round(coalesce(sum(final_balance),0)) as total_owed from delinquency where ${where.join(" and ")}`;
      return {sql,binds,chosen};
    },
    headline(r){return [`${fmt(r.parcels)} parcels delinquent`, `$${fmt(r.total_owed)} total owed`];}
  },
  new_residential_construction:{
    label:"New residential construction (permits)", table:"permit", unit:"permits",
    description:"New-construction residential building permits recorded in the Auditor's permit copy, by permit year.",
    provenance:"Counts building permits (category P_BLD, nature NEW), not homes on the tax roll. The work-type code is only ~44% populated, so 'any residential' is an over-count.",
    build(p,cov){
      const year=resolveYear(p.year,cov); const scope=(p.scope||"single_family").toLowerCase();
      const where=["permit_year = :year","category_code = 'P_BLD'","work_nature_code = 'NEW'"];
      const binds={":year":year}; const chosen={year,scope};
      if(scope==="any_residential"){
        const ph=RES_WORK.map((_,i)=>":wt"+i);
        where.push(`work_type_code in (${ph.join(",")})`);
        RES_WORK.forEach((c,i)=>binds[":wt"+i]=c);
      } else { where.push("work_type_code = 'R_SIN'"); }
      applyGeo(p,where,binds,chosen);
      return {sql:`select count(*) as permits from permit where ${where.join(" and ")}`, binds, chosen};
    },
    headline(r){return [`${fmt(r.permits)} permits`];}
  },
  dwellings:{
    label:"Residential dwellings", table:"dwelling", unit:"dwellings",
    description:"Residential dwellings on the appraisal roll, by tax year -- with average living area and year built -- filterable by grade, style, neighborhood, city, township, and school district.",
    provenance:"One row per dwelling. Year built lags one roll (a home finished in year Y appears on the Y+1 roll). Neighborhood is the appraisal code, not a named subdivision. City is the situs (mailing) city; township and school district are the taxing jurisdictions.",
    build(p,cov){
      const year=resolveYear(p.year,cov); const focus=(p.focus||"count").toLowerCase();
      const where=["tax_year = :year"]; const binds={":year":year}; const chosen={year,focus};
      for(const k of ["grade","style","neighborhood","exterior_wall","basement","central_air",
                      "heating_fuel","condition","basement_finish","bedrooms","full_baths"]){
        const col=(k==="neighborhood")?"nbhd":k;
        applyText(p,k,col,where,binds,chosen);
      }
      applyGeo(p,where,binds,chosen);
      const sql=`select count(*) as dwellings, round(coalesce(avg(sfla),0)) as avg_sfla, round(coalesce(avg(yrblt),0)) as avg_yrblt from dwelling where ${where.join(" and ")}`;
      return {sql,binds,chosen};
    },
    headline(r,chosen){
      const n=r.dwellings; if(n===0) return ["0 dwellings match"];
      const size=r.avg_sfla?`${fmt(r.avg_sfla)} sq ft average living area`:null;
      const year=r.avg_yrblt?`${r.avg_yrblt} average year built`:null;
      const focus=(chosen&&chosen.focus)||"count";
      if(focus==="year_built") return [year||"average year built n/a", `across ${fmt(n)} dwellings`].concat(size?[size]:[]);
      if(focus==="size") return [size||"average living area n/a", `across ${fmt(n)} dwellings`].concat(year?[year]:[]);
      return [`${fmt(n)} dwellings`].concat([size,year].filter(Boolean));
    }
  },
  property_values:{
    label:"Property values (appraised)", table:"property_values", unit:"parcels",
    description:"Current appraised land, building, and total values from the certified assessment roll, by tax year -- with the median and average total value.",
    provenance:"Appraised values are 100% MARKET value from the certified assessment roll (ASMT). TAXABLE value is 35% of these figures. One row per parcel. Aggregate figures only; no owner or address is stored.",
    build(p,cov){
      const year=resolveYear(p.year,cov); const cls=(p.class||"all").toLowerCase();
      const where=["tax_year = :year"]; const binds={":year":year}; const chosen={year,class:cls};
      const codes={residential:"R",commercial:"C",agricultural:"A",industrial:"I",exempt:"E"};
      if(cls!=="all" && codes[cls]){ where.push("property_class = :cls"); binds[":cls"]=codes[cls]; }
      applyText(p,"neighborhood","nbhd",where,binds,chosen);
      applyGeo(p,where,binds,chosen);
      const w=where.join(" and ");
      const med=medianExpr("total_value","property_values",w);
      const sql=`select count(*) as parcels, round(coalesce(avg(land_value),0)) as avg_land, round(coalesce(avg(building_value),0)) as avg_building, round(coalesce(avg(total_value),0)) as avg_total, round(coalesce(${med},0)) as median_total, round(coalesce(sum(total_value),0)) as total_value_sum from property_values where ${w}`;
      return {sql,binds,chosen};
    },
    headline(r){return [`${fmt(r.parcels)} parcels`,
      `$${fmt(r.median_total)} median total value`,
      `$${fmt(r.avg_total)} average total value`,
      `$${fmt(r.total_value_sum)} total appraised value`];}
  },
  exempt_property:{
    label:"Exempt real property", table:"exempt", unit:"parcels",
    description:"Tax-exempt parcels (property class E) and the value exempted, by tax year -- government, charitable, worship, and similar grounds.",
    provenance:"Class-E parcels; value exempted is the parcel's appraised total. Land-use 600-699 are ORC 5713.08 exemptions; 700-799 are tax abatements and TIFs, a separate mechanism reported apart. The list moves day to day, so the refresh date matters.",
    build(p,cov){
      const year=resolveYear(p.year,cov); const kind=(p.kind||"all").toLowerCase();
      const where=["tax_year = :year"]; const binds={":year":year}; const chosen={year,kind};
      if(kind==="exemptions") where.push("record_type = 'exemption'");
      else if(kind==="abatements") where.push("record_type = 'abatement_tif'");
      applyGeo(p,where,binds,chosen);
      const sql=`select count(*) as parcels, round(coalesce(sum(exempt_total),0)) as total_value from exempt where ${where.join(" and ")}`;
      return {sql,binds,chosen};
    },
    headline(r){return [`${fmt(r.parcels)} exempt parcels`, `$${fmt(r.total_value)} total value exempted`];}
  },
  owner_occupancy_credit:{
    label:"Owner-occupancy (2.5%) credit", table:"owner_occupancy", unit:"parcels",
    description:"Parcels receiving the 2.5% owner-occupancy tax credit, by tax year.",
    provenance:"The 2.5% owner-occupancy credit (ASMT.FLAG4). A separate, much larger population than the homestead exemption (~102k parcels/yr vs ~27k) -- every homestead parcel also carries it, but most credit parcels are not homestead. Aggregate counts only.",
    build(p,cov){
      const year=resolveYear(p.year,cov);
      const where=["tax_year = :year"]; const binds={":year":year}; const chosen={year};
      applyGeo(p,where,binds,chosen);
      return {sql:`select count(*) as parcels from owner_occupancy where ${where.join(" and ")}`, binds, chosen};
    },
    headline(r){return [`${fmt(r.parcels)} parcels`];}
  },
  bor_complaints:{
    label:"Board of Revision complaints", table:"bor", unit:"complaints",
    description:"Formal Board of Revision complaints (DTE 1) on residential property, by tax year, filterable by complaint kind and the Board's outcome.",
    provenance:"Residential parcels only and formal DTE-1 complaints only. Roughly half the residential docket is NOT a valuation complaint (penalty removal, CAUV, homestead, owner-occupancy also ride on it). Counts complaint cases, not parcels. A case counts as 'reduced' if the Board decreased the value on any parcel in it. No city / township / school-district filter applies to complaints.",
    build(p,cov){
      const year=resolveYear(p.year,cov); const kind=(p.kind||"all").toLowerCase();
      const outcome=(p.outcome||"all").toLowerCase();
      const where=["tax_year = :year"]; const binds={":year":year}; const chosen={year,kind,outcome};
      if(kind==="valuation") where.push("is_valuation = 1");
      if(outcome!=="all"){
        const code={reduced:"decrease",no_change:"no_change",increased:"increase"}[outcome];
        if(code){ where.push("outcome = :oc"); binds[":oc"]=code; }
      }
      return {sql:`select count(*) as complaints from bor where ${where.join(" and ")}`, binds, chosen};
    },
    headline(r){return [`${fmt(r.complaints)} complaints`];}
  },
  building_permits:{
    label:"Building permits", table:"permit", unit:"permits",
    description:"Permits in the Auditor's permit copy, by permit year and category (building, demolition, over-the-counter).",
    provenance:"The Auditor's appraisal-driven copy of permit activity, bulk-loaded from the county and municipal building departments -- not the issuing departments' authoritative system, and incomplete by nature. For new-home counts specifically, use new residential construction instead.",
    build(p,cov){
      const year=resolveYear(p.year,cov); const category=(p.category||"building").toLowerCase();
      const where=["permit_year = :year"]; const binds={":year":year}; const chosen={year,category};
      const codes={building:"P_BLD",demolition:"P_DEM",over_the_counter:"P_OTC"};
      if(category!=="all" && codes[category]){ where.push("category_code = :cat"); binds[":cat"]=codes[category]; }
      applyGeo(p,where,binds,chosen);
      return {sql:`select count(*) as permits from permit where ${where.join(" and ")}`, binds, chosen};
    },
    headline(r){return [`${fmt(r.permits)} permits`];}
  },
  property_sales:{
    label:"Property sales", table:"property_sales", unit:"sales",
    description:"Recorded property sales by sale year, with the median and average sale price and total dollar volume. Defaults to valid arm's-length (market) sales; filterable by validity, property class, deed type, neighborhood, city, township, and school district.",
    provenance:"Counted by sale record (a single sale spanning multiple parcels counts more than once, inflating volume). DEFAULT is valid arm's-length sales (validity 0) for a general sales or price question; 'all' adds non-market transfers -- family transfers, foreclosures, auctions, $0 transfers. When a specific DEED TYPE is named, all validities are counted by default (such a deed is not an arm's-length sale). Price stats use only sales with a recorded price above zero; the answer notes how many of the counted sales had one.",
    build(p,cov){
      const year=resolveYear(p.year,cov); const cls=(p.class||"all").toLowerCase();
      const deed=p.deed_type;
      const deedNamed=(typeof deed==="string" && !["","all","unspecified"].includes(deed.trim().toLowerCase()));
      let validity=(p.validity||"auto").toLowerCase();
      if(validity==="auto") validity = deedNamed ? "all" : "valid";
      const where=["sale_year = :year"]; const binds={":year":year}; const chosen={year,validity,class:cls};
      if(validity==="valid") where.push("valid = 1");
      const codes={residential:"R",commercial:"C",agricultural:"A",industrial:"I",exempt:"E"};
      if(cls!=="all" && codes[cls]){ where.push("property_class = :cls"); binds[":cls"]=codes[cls]; }
      applyText(p,"deed_type","deed_type",where,binds,chosen);
      applyText(p,"neighborhood","nbhd",where,binds,chosen);
      applyGeo(p,where,binds,chosen);
      const w=where.join(" and ");
      const med=medianExpr("sale_price","property_sales",w+" and sale_price > 0");
      const sql=`select count(*) as sales, round(coalesce(avg(case when sale_price>0 then sale_price end),0)) as avg_price, round(coalesce(${med},0)) as median_price, round(coalesce(sum(case when sale_price>0 then sale_price end),0)) as total_volume, sum(case when sale_price>0 then 1 else 0 end) as sales_with_price from property_sales where ${w}`;
      return {sql,binds,chosen};
    },
    headline(r){
      const n=r.sales, wp=r.sales_with_price||0;
      const out=[`${fmt(n)} sales`, `$${fmt(r.median_price)} median price`,
        `$${fmt(r.avg_price)} average price`, `$${fmt(r.total_volume)} total dollar volume`];
      if(wp<n) out.push(`(${fmt(wp)} of ${fmt(n)} had a recorded price)`);
      return out;
    }
  }
};

// ---- The engine: validate, run, return a structured result -----------------
function runMetric(mid, params){
  const m=METRICS[mid]; if(!m) return {status:"unknown_metric"};
  const cov=coverage(m.table); if(!cov) return {status:"no_data"};
  params=Object.assign({}, params);
  for(const [pname,[dtable,dcol,label]] of Object.entries(TEXT_DOMAINS)){
    const v=params[pname];
    if(typeof v!=="string" || ["all","unspecified",""].includes(v.trim().toLowerCase())) continue;
    const known=queryCol(`select distinct ${dcol} as v from ${dtable} where ${dcol} is not null`);
    const needle=v.trim().toUpperCase();
    const up=known.map(k=>String(k).toUpperCase());
    if(!up.includes(needle)){
      const near=known.filter(k=>{const s=String(k).toUpperCase(); return s.includes(needle)||needle.includes(s);});
      return {status:"unknown_value", param:pname, label, value:v.trim(), suggestions:near.slice(0,6)};
    }
  }
  let built;
  try{ built=m.build(params,cov); }
  catch(e){ if(e&&e.oor) return {status:"out_of_range", message:e.msg}; throw e; }
  const row=queryRow(built.sql, built.binds);
  return {status:"ok", metric:mid, row, chosen:built.chosen, coverage:cov};
}
function renderNonOk(res){
  if(res.status==="unknown_value"){
    let m=`I don't have a ${res.label} of “${res.value}” in the records.`;
    if(res.suggestions&&res.suggestions.length) m+=" Did you mean: "+res.suggestions.join(", ")+"?";
    else if(res.param==="city") m+=" Note this is the situs (mailing) city, not the township.";
    return m;
  }
  if(res.status==="out_of_range") return `I don't have that. ${res.message}.`;
  return "I don't have that.";
}

// ---- Intent tool schema + system prompt (used by the network call) ---------
function intentTool(){
  return {
    name:"resolve_intent",
    description:"Map the user's question to exactly one Ask Stark catalog metric and its parameters, or 'none' if no catalog metric fits.",
    input_schema:{ type:"object", additionalProperties:false,
      properties:{
        metric:{type:"string", enum:Object.keys(METRICS).concat(["none"])},
        confidence:{type:"string", enum:["high","medium","low"]},
        year:{type:["integer","null"], description:"A 4-digit year only if the user named one; 'this year'/'latest' -> null."},
        tier:{type:"string", enum:["all","standard","enhanced","unspecified"], description:"homestead only."},
        vacant:{type:"string", enum:["include","exclude","only","unspecified"], description:"delinquency only."},
        scope:{type:"string", enum:["single_family","any_residential","unspecified"], description:"new construction only."},
        class:{type:"string", enum:["all","residential","commercial","agricultural","industrial","exempt","unspecified"], description:"property_values / property_sales / homestead class."},
        kind:{type:"string", enum:["all","exemptions","abatements","valuation","unspecified"], description:"exempt_property ('exemptions' = ORC 5713.08, 'abatements' = tax abatements/TIFs) OR bor_complaints ('valuation' = valuation complaints only). 'unspecified' otherwise."},
        outcome:{type:"string", enum:["all","reduced","no_change","increased","unspecified"], description:"bor_complaints Board outcome. Use 'reduced' when the user asks for complaints where the value was reduced/lowered/decreased. 'unspecified' otherwise."},
        category:{type:"string", enum:["building","demolition","over_the_counter","all","unspecified"], description:"building_permits category (default building). 'unspecified' otherwise."},
        validity:{type:"string", enum:["valid","all","unspecified"], description:"property_sales: 'valid' = arm's-length market sales (default), 'all' = every recorded transfer incl. non-market (family, foreclosure, $0). 'unspecified' -> valid."},
        deed_type:{type:"string", enum:DEED_TYPES.concat(["unspecified"]), description:"property_sales: a deed/instrument type the user names ('sheriff's sales'->'Sheriff's Deed', 'quit claims'->'Quit Claim Deed', 'warranty deed'->'General Warranty Deed'). 'unspecified' if none."},
        focus:{type:"string", enum:["count","year_built","size","unspecified"], description:"dwellings: which figure to lead with."},
        city:{type:"string", description:"A CITY/village name UPPERCASE (situs/mailing city). 'unspecified' if none, or if a township (use township)."},
        township:{type:"string", enum:TOWNSHIPS.concat(["unspecified"]), description:"A TOWNSHIP (e.g. 'Jackson Township'->'JACKSON TWP'). Taxing jurisdiction, different from a city. 'unspecified' if none."},
        school_district:{type:"string", enum:SCHOOL_DISTRICTS.concat(["unspecified"]), description:"A SCHOOL DISTRICT ('Plain schools'->'PLAIN LSD', 'Canton City schools'->'CANTON CSD'; CSD=City, LSD=Local). 'unspecified' if none."},
        grade:{type:"string", description:"dwellings: a quality grade UPPERCASE (A+, A, B, C, ...). 'unspecified' if none."},
        style:{type:"string", description:"dwellings: a home style word ('ranch','colonial','bungalow'). 'unspecified' if none."},
        neighborhood:{type:"string", description:"An appraisal neighborhood code (e.g. RS14203) UPPERCASE. 'unspecified' if none."},
        exterior_wall:{type:"string", description:"dwellings: exterior wall ('brick','stone','wood siding frame'). 'unspecified' if none."},
        basement:{type:"string", description:"dwellings: basement type ('full','walkout','none','crawl'). 'unspecified' if none."},
        central_air:{type:"string", description:"dwellings: 'AC' for central air, 'No AC' without. 'unspecified' if none."},
        heating_fuel:{type:"string", description:"dwellings: heating fuel ('gas','electric','oil','propane'). 'unspecified' if none."},
        condition:{type:"string", description:"dwellings: condition ('excellent','good','average','fair','poor'). 'unspecified' if none."},
        basement_finish:{type:"string", description:"dwellings: basement finish ('none' for unfinished, else 'Full / Equal' etc.). 'unspecified' if none."},
        bedrooms:{type:"string", description:"dwellings: number of bedrooms as digits (e.g. '3'). 'unspecified' if none."},
        full_baths:{type:"string", description:"dwellings: number of full baths as digits. 'unspecified' if none."},
        continues:{type:"boolean", description:"True if this refines the PREVIOUS RESULT (narrows/changes one filter/asks a related detail). False for a new topic or when there is no previous result."},
        referral:{type:"string", enum:Object.keys(REFERRALS).concat(["none"]), description:"When metric is 'none', the best referral, else 'none'."},
        reasoning:{type:"string", description:"One sentence: why this metric, or why none."}
      },
      required:["metric","confidence","year","tier","vacant","scope","class","kind",
        "outcome","category","validity","deed_type","focus",
        "city","township","school_district","grade","style","neighborhood",
        "exterior_wall","basement","central_air","heating_fuel","condition",
        "basement_finish","bedrooms","full_baths","continues","referral","reasoning"]
    }
  };
}
function systemPrompt(){
  let L=["You are the intent mapper for Ask Stark, which answers questions about Stark County Auditor public records from a fixed catalog of metrics.",
    "Map the user's question to EXACTLY ONE metric below, or 'none'.",
    "- Choose a metric only if the question clearly asks for what it measures. If it is outside the catalog or you are unsure, return 'none' -- never guess. An honest 'I don't have that' is correct.",
    "- Fill a parameter ONLY if the user stated it; otherwise 'unspecified' (year: null).",
    "- Set parameters that do not belong to the chosen metric to 'unspecified'.",
    "- confidence 'high' only when unambiguous.",
    "- When metric is 'none', set referral to the best match below, else 'none'.",
    "FOLLOW-UPS: if a PREVIOUS RESULT is given and the new question refines it, keep the metric, CARRY FORWARD every previous parameter, change only what is stated, and set continues=true. A new topic -> continues=false.",
    "CATALOG:"];
  for(const [mid,m] of Object.entries(METRICS)) L.push(`[${mid}] ${m.label}: ${m.description}`);
  L.push("REFERRALS (only when metric='none'):");
  L.push("[property_lookup] one specific property -- owner/value/sales/taxes of a single parcel or address");
  L.push("[treasurer] the official/published delinquent list, tax payments, payment plans, due dates");
  return L.join("\n");
}

const PARAM_KEYS=["year","focus","tier","vacant","scope","class","kind","outcome",
  "category","validity","deed_type","city","township","school_district","grade",
  "style","neighborhood","exterior_wall","basement","central_air","heating_fuel",
  "condition","basement_finish","bedrooms","full_baths"];
const HIDDEN=["focus"];

const API = {setDb, runMetric, renderNonOk, coverage, refreshedAt, fmt,
  intentTool, systemPrompt, METRICS, TEXT_DOMAINS, REFERRALS,
  TOWNSHIPS, SCHOOL_DISTRICTS, PARAM_KEYS, HIDDEN};
if(typeof module!=="undefined" && module.exports) module.exports = API;
if(typeof window!=="undefined") window.AskStarkEngine = API;
})();
