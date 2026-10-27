//! Local BibTeX parsing. No TeX execution or network lookup occurs on import.
use std::collections::{BTreeMap,HashMap,HashSet};
use anyhow::{bail,Context,Result};
use serde_json::{json,Value};
struct Parser {s:Vec<char>,p:usize,strings:HashMap<String,String>}
impl Parser {
 fn space(&mut self){loop{while self.p<self.s.len()&&self.s[self.p].is_whitespace(){self.p+=1;}if self.s.get(self.p)==Some(&'%'){while self.p<self.s.len()&&self.s[self.p]!='\n'{self.p+=1;}}else{break;}}}
 fn token(&mut self)->String{self.space();let start=self.p;while self.p<self.s.len()&&!self.s[self.p].is_whitespace()&&!"=,{}()#\"".contains(self.s[self.p]){self.p+=1;}self.s[start..self.p].iter().collect()}
 fn expect(&mut self,c:char)->Result<()>{self.space();if self.s.get(self.p)!=Some(&c){bail!("Expected '{c}' near character {}",self.p);}self.p+=1;Ok(())}
 fn group(&mut self)->Result<String>{let open=self.s[self.p];let close=if open=='{'{'}'}else{'"'};self.p+=1;let mut depth=0;let mut out=String::new();while self.p<self.s.len(){let c=self.s[self.p];self.p+=1;if c=='\\'{out.push(c);if let Some(c)=self.s.get(self.p){out.push(*c);self.p+=1;}continue;}if c==close&&depth==0{return Ok(out);}if c=='{'{depth+=1;}if c=='}'{if depth==0{bail!("Unbalanced braces");}depth-=1;}out.push(c);}bail!("Unterminated BibTeX value")}
 fn value(&mut self)->Result<String>{let mut out=String::new();loop{self.space();match self.s.get(self.p){Some('{')|Some('"')=>out.push_str(&self.group()?),Some(_)=>{let t=self.token();if t.is_empty(){bail!("Missing field value");}if t.chars().all(|c|c.is_ascii_digit()){out.push_str(&t);}else {out.push_str(self.strings.get(&t.to_lowercase()).with_context(||format!("Undefined BibTeX string: {t}"))?);}},None=>bail!("Missing field value")};self.space();if self.s.get(self.p)!=Some(&'#'){break;}self.p+=1;}Ok(out)}
}
// TEMPORARY Tectonic 0.17.0 compatibility workaround (paper builds only).
// Its BibTeX drops whitespace when expanding @string aliases; e.g.
// @string{venue={{Foundations and Trends in Machine Learning}}}, journal=venue.
// Standard BibTeX preserves those spaces. Inline previously defined local aliases
// in the disposable .bib build copy, leaving stored/imported bibliography bytes
// untouched. Do NOT use the citation-index parser's plain-text output here: that
// would discard TeX accents, case-protection braces, and arbitrary custom fields.
//
// REMOVE this function and its paper::compile call/version gate when the bundled
// Tectonic passes the unmodified macro-spacing fixture in paper-integration.py.
// Keep that end-to-end fixture as a regression test after removing the workaround.
// Unknown/external aliases remain for BibTeX to resolve; malformed input is left
// entirely unchanged so the compiler can report its original diagnostics.
pub(crate) fn tectonic_string_spacing(source: &str) -> Result<String> {
    let mut p = Parser { s: source.chars().collect(), p: 0, strings: HashMap::new() };
    let mut replacements: Vec<(usize, usize, String)> = Vec::new();

    // Parse expressions, not regex matches: identifiers inside titles, comments,
    // TeX commands, or citation keys must never be mistaken for string aliases.
    fn value(p: &mut Parser, edits: &mut Vec<(usize, usize, String)>) -> Result<Option<String>> {
        let mut resolved = Some(String::new());
        loop {
            p.space();
            let part = match p.s.get(p.p) {
                Some('{') | Some('"') => Some(p.group()?),
                Some(_) => {
                    let start = p.p;
                    let token = p.token();
                    anyhow::ensure!(!token.is_empty(), "Missing BibTeX value");
                    if token.chars().all(|c| c.is_ascii_digit()) { Some(token) }
                    else if let Some(text) = p.strings.get(&token.to_lowercase()) {
                        edits.push((start, p.p, format!("{{{text}}}")));
                        Some(text.clone())
                    } else { None }
                }
                None => bail!("Missing BibTeX value"),
            };
            resolved = resolved.zip(part).map(|(mut a, b)| { a.push_str(&b); a });
            p.space();
            if p.s.get(p.p) != Some(&'#') { break; }
            p.p += 1;
        }
        // BibTeX collapses literal whitespace. Normalizing aliases here also
        // keeps replacement text on one line, preserving source line numbers.
        Ok(resolved.map(|s| {
            let mut out = String::new();
            let mut space = false;
            for c in s.chars() {
                if c.is_ascii_whitespace() {
                    if !space { out.push(' '); }
                    space = true;
                } else { out.push(c); space = false; }
            }
            out
        }))
    }

    while p.p < p.s.len() {
        p.space();
        if p.p >= p.s.len() { break; }
        if p.s[p.p] != '@' { p.p += 1; continue; }
        p.p += 1;
        let kind = p.token().to_lowercase();
        p.space();
        let open = *p.s.get(p.p).context("Missing BibTeX body")?;
        anyhow::ensure!(open == '{' || open == '(', "Invalid BibTeX body");
        p.p += 1;
        let close = if open == '{' { '}' } else { ')' };
        if kind == "comment" {
            let mut depth = 1;
            while p.p < p.s.len() && depth > 0 {
                let c = p.s[p.p]; p.p += 1;
                if c == open { depth += 1; }
                if c == close { depth -= 1; }
            }
            anyhow::ensure!(depth == 0, "Unterminated BibTeX comment");
            continue;
        }
        if kind == "string" || kind == "preamble" {
            let name = if kind == "string" {
                let name = p.token().to_lowercase(); p.expect('=')?; Some(name)
            } else { None };
            let text = value(&mut p, &mut replacements)?;
            if let Some(name) = name {
                // Sequential scope preserves redefinitions. Never guess the value
                // of a forward reference, built-in month, or cross-file alias.
                p.strings.remove(&name);
                if let Some(text) = text { p.strings.insert(name, text); }
            }
            p.space();
            if p.s.get(p.p) == Some(&',') { p.p += 1; }
            p.expect(close)?;
            continue;
        }
        anyhow::ensure!(!p.token().is_empty(), "Missing citation key");
        p.expect(',')?;
        loop {
            p.space();
            if p.s.get(p.p) == Some(&close) { p.p += 1; break; }
            anyhow::ensure!(!p.token().is_empty(), "Missing field name");
            p.expect('=')?;
            value(&mut p, &mut replacements)?;
            p.space();
            if p.s.get(p.p) == Some(&',') { p.p += 1; }
            else { p.expect(close)?; break; }
        }
    }
    let mut output = String::new();
    let mut cursor = 0;
    for (start, end, text) in replacements {
        output.extend(p.s[cursor..start].iter());
        output.push_str(&text);
        cursor = end;
    }
    output.extend(p.s[cursor..].iter());
    Ok(output)
}

fn plain(s:&str)->String{let mut out=s.replace(['{','}'],"");for (from,to) in [("\\&","&"),("\\%","%"),("\\_","_"),("\\textendash","–"),("\\textemdash","—"),("\\'e","é"),("\\\"o","ö"),("\\\"u","ü"),("\\\"a","ä"),("\\~n","ñ")]{out=out.replace(from,to);}out.split_whitespace().collect::<Vec<_>>().join(" ")}
pub fn parse(source:&str)->Result<Vec<Value>>{
 let mut p=Parser{s:source.chars().collect(),p:0,strings:HashMap::new()};for(m,n)in ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].iter().enumerate(){p.strings.insert(n.to_string(),(m+1).to_string());}
 let mut entries:Vec<(String,String,BTreeMap<String,String>)>=Vec::new();let mut keys=HashSet::new();
 while p.p<p.s.len(){p.space();if p.p>=p.s.len(){break;}if p.s[p.p]!='@'{p.p+=1;continue;}p.p+=1;let kind=p.token().to_lowercase();p.space();let open=*p.s.get(p.p).context("Expected entry body")?;if open!='{'&&open!='(' {bail!("Expected entry body");}p.p+=1;let close=if open=='{'{'}'}else{')'};
  if kind=="comment"{let mut depth=1;while p.p<p.s.len()&&depth>0{let c=p.s[p.p];p.p+=1;if c==open{depth+=1;}if c==close{depth-=1;}}if depth!=0{bail!("Unterminated comment");}continue;}
  if kind=="preamble"{p.value()?;p.space();if p.s.get(p.p)==Some(&','){p.p+=1;}p.expect(close)?;continue;}
  if kind=="string"{let key=p.token().to_lowercase();p.expect('=')?;let value=p.value()?;p.strings.insert(key,value);p.space();if p.s.get(p.p)==Some(&','){p.p+=1;}p.expect(close)?;continue;}
  let key=p.token();if key.is_empty()||!keys.insert(key.clone()){bail!("Missing or duplicate citation key: {key}");}p.expect(',')?;let mut fields=BTreeMap::new();
  loop{p.space();if p.s.get(p.p)==Some(&close){p.p+=1;break;}let name=p.token().to_lowercase();if name.is_empty(){bail!("Expected field in {key}");}p.expect('=')?;let value=p.value()?;fields.insert(name,value);p.space();if p.s.get(p.p)==Some(&','){p.p+=1;}else {p.expect(close)?;break;}}
  entries.push((key,kind,fields));
 }
 let refs:HashMap<_,_>=entries.iter().map(|(k,_,f)|(k.clone(),f.clone())).collect();
 Ok(entries.into_iter().map(|(key,kind,mut fields)|{
  if let Some(parent)=fields.get("crossref").and_then(|k|refs.get(k)){for(k,v)in parent {fields.entry(k.clone()).or_insert(v.clone());}}
  let get=|k:&str|plain(fields.get(k).map(String::as_str).unwrap_or(""));
  let creators:Vec<String>=fields.get("author").or_else(||fields.get("editor")).map(|s|s.split(" and ").map(|name|{let name=plain(name);if let Some((last,first))=name.split_once(','){format!("{} {}",first.trim(),last.trim())}else{name}}).collect()).unwrap_or_default();
  json!({"key":key,"type":kind,"title":get("title"),"creators":creators,"year":get("year"),"doi":get("doi"),"url":get("url"),"bib":true,"fields":fields})
 }).collect())
}
pub fn index(app:&crate::App,target:&str,m:&Value)->Result<Vec<Value>>{
 let library=app.library.items(target)?;
 let mut result=Vec::new();
 for e in m["entries"].as_array().context("Invalid project entries")?.iter().filter(|e|e["kind"]=="file"&&e["deleted"]!=true&&e["name"].as_str().unwrap_or("").to_ascii_lowercase().ends_with(".bib")){
  let id=&e["id"];
  let bytes=crate::workspace::bytes(app,target,e)?;let source=std::str::from_utf8(&bytes).context("Bibliography must be UTF-8")?;
  for mut entry in parse(source).with_context(||format!("{}",e["name"].as_str().unwrap_or("Bibliography")))?{
   entry["file_id"]=id.clone();entry["file_name"]=e["name"].clone();
   if let Some(p)=library.iter().find(|p|!entry["doi"].as_str().unwrap_or("").is_empty()&&p["doi"].as_str().unwrap_or("").eq_ignore_ascii_case(entry["doi"].as_str().unwrap())){entry["library_key"]=p["key"].clone();}
   result.push(entry);
  }
 } Ok(result)
}
#[cfg(test)]mod tests{use super::*;#[test]fn bib(){let v=parse(r#"@string{venue="A" # "B"} @article{k, title={A {Nested} Title},author={Lovelace, Ada and Turing, Alan},year=1936,journal=venue} @book{x,title="Other",crossref={k}}"#).unwrap();assert_eq!(v[0]["title"],"A Nested Title");assert_eq!(v[0]["creators"][0],"Ada Lovelace");assert_eq!(v[1]["year"],"1936");assert!(parse("@article{k,title={oops}").is_err());assert!(parse("@misc{k,} @misc{k,}").is_err());}}

/// Paper suggestions use every live .bib, independently of note bibliography settings.
pub async fn search(axum::extract::State(app):crate::Shared,axum::extract::Path(target):axum::extract::Path<String>)->crate::ApiResult {
 let m=crate::workspace::paper_manifest(&app,&target)?;let mut entries=Vec::new();let mut errors=Vec::new();
 for file in m["entries"].as_array().into_iter().flatten().filter(|e|e["kind"]=="file"&&e["deleted"]!=true&&e["name"].as_str().unwrap_or("").to_lowercase().ends_with(".bib")) {
  let parsed=(||->Result<Vec<Value>>{let path=crate::workspace::file_path(&app,&target,file)?;anyhow::ensure!(std::fs::metadata(&path)?.len()<=2<<20,"Bibliography search supports files up to 2 MB");parse(std::str::from_utf8(&std::fs::read(path)?)?)})();
  match parsed {Ok(items)=>for mut item in items {item["file_id"]=file["id"].clone();item["file_name"]=file["name"].clone();entries.push(item);},Err(e)=>errors.push(format!("{}: {e}",file["name"].as_str().unwrap_or("Bibliography")))}
 }
 Ok(axum::Json(json!({"entries":entries,"errors":errors})))
}

#[cfg(test)]
mod tectonic_spacing_tests {
    use super::tectonic_string_spacing;

    #[test]
    fn expands_only_local_alias_tokens_without_losing_tex_or_scope() {
        let source = r#"% @string{ignored="wrong"}
@Comment{journal=venue, @string{ignored="wrong"}}
@STRING(venue = {{Foundations and Trends in Machine Learning}})
@string{suffix = " and " # {Other Studies}}
@string{combined = venue # suffix}
@article{venue, title={venue and {Case} and \"{o}}, journal=VENUE,
  note=combined # "!", month=jan, year=2026, custom=external}
@string{venue="New Venue"}
@misc{second, journal=venue, title="venue"}
@string{venue=unknown}
@misc{third, journal=venue}
"#;
        let result = tectonic_string_spacing(source).unwrap();
        assert!(result.contains("journal={{Foundations and Trends in Machine Learning}}"));
        assert!(result.contains("note={{Foundations and Trends in Machine Learning} and Other Studies} # \"!\""));
        assert!(result.contains(r#"title={venue and {Case} and \"{o}}"#));
        assert!(result.contains("month=jan, year=2026, custom=external"));
        assert!(result.contains(r#"@misc{second, journal={New Venue}, title="venue"}"#));
        assert!(result.contains("@misc{third, journal=venue}"));
        assert!(result.contains("@Comment{journal=venue, @string{ignored=\"wrong\"}}"));
        assert_eq!(result.lines().count(), source.lines().count());
    }

    #[test]
    fn preserves_literal_files_and_rejects_incomplete_input() {
        let source = "@article{k, journal={Already spaced}, title={é {Title}}, year=2026}";
        assert_eq!(tectonic_string_spacing(source).unwrap(), source);
        assert!(tectonic_string_spacing("@string{x={A B}} @article{k,journal=x").is_err());
        assert_eq!(tectonic_string_spacing("@string{x={}} @misc{k,note=x}").unwrap(),
                   "@string{x={}} @misc{k,note={}}");
    }

    #[test]
    fn reassess_workaround_when_upgrading_tectonic() {
        // On upgrade, run paper-integration.py with the version gate disabled.
        // If it passes, delete the workaround and these unit tests; retain the
        // original @string integration fixture to catch future engine regressions.
        assert_eq!(crate::paper::VERSION, "0.17.0", "Reassess/remove the BibTeX spacing workaround");
    }
}
