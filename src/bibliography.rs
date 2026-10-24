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
 let mut keys=HashSet::new();let library=app.library.items(target)?;
 for it in &library{if let Some(k)=it["key"].as_str(){keys.insert(k.to_owned());}if let Some(aliases)=it["cite_keys"].as_array(){for k in aliases{if let Some(k)=k.as_str(){keys.insert(k.into());}}}}
 let mut result=Vec::new();
 for id in m["bibliographies"].as_array().context("Invalid bibliography selection")?{
  let e=m["entries"].as_array().unwrap().iter().find(|e|e["id"]==*id&&e["deleted"]!=true).context("An enabled bibliography is missing")?;
  let bytes=crate::workspace::bytes(app,target,e)?;let source=std::str::from_utf8(&bytes).context("Bibliography must be UTF-8")?;
  for mut entry in parse(source).with_context(||format!("{}",e["name"].as_str().unwrap_or("Bibliography")))?{
   let k=entry["key"].as_str().unwrap();if !keys.insert(k.to_owned()){bail!("Citation key '{k}' conflicts with another bibliography or library citation. Rename it before enabling this bibliography.");}
   entry["file_id"]=id.clone();entry["file_name"]=e["name"].clone();
   if let Some(p)=library.iter().find(|p|!entry["doi"].as_str().unwrap_or("").is_empty()&&p["doi"].as_str().unwrap_or("").eq_ignore_ascii_case(entry["doi"].as_str().unwrap())){entry["library_key"]=p["key"].clone();}
   result.push(entry);
  }
 } Ok(result)
}
#[cfg(test)]mod tests{use super::*;#[test]fn bib(){let v=parse(r#"@string{venue="A" # "B"} @article{k, title={A {Nested} Title},author={Lovelace, Ada and Turing, Alan},year=1936,journal=venue} @book{x,title="Other",crossref={k}}"#).unwrap();assert_eq!(v[0]["title"],"A Nested Title");assert_eq!(v[0]["creators"][0],"Ada Lovelace");assert_eq!(v[1]["year"],"1936");assert!(parse("@article{k,title={oops}").is_err());assert!(parse("@misc{k,} @misc{k,}").is_err());}}
