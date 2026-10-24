//! Session-only transaction journals. Callers hold their resource lock until persistence succeeds.
use std::{collections::HashMap, sync::{Mutex, OnceLock}};
use serde_json::{json, Value};
use anyhow::{bail, Result};
#[derive(Clone)]
pub struct Change { pub before: Value, pub after: Value, pub label: String }
#[derive(Default)]
pub struct Journal { undo: Vec<Change>, redo: Vec<Change> }
impl Journal {
    pub fn record(&mut self, before: Value, after: Value, label: &str) {
        if before == after { return; }
        self.undo.push(Change {before, after, label:label.into()}); self.redo.clear();
        while self.undo.len()>200 || (self.undo.len()>1 && self.undo.iter().map(|c| c.before.to_string().len()+c.after.to_string().len()).sum::<usize>()>16<<20) { self.undo.remove(0); }
    }
    pub fn status(&self)->Value { json!({"undo":self.undo.last().map(|c|&c.label),"redo":self.redo.last().map(|c|&c.label)}) }
    pub fn pending(&self, redo:bool, current:&Value)->Result<Value> {
        let change=if redo {self.redo.last()} else {self.undo.last()};
        let Some(c)=change else {bail!("Nothing to {}",if redo {"redo"} else {"undo"})};
        if current != if redo {&c.before} else {&c.after} { return Err(crate::Status(axum::http::StatusCode::CONFLICT,"This document changed elsewhere. Reload before undoing.".into()).into()); }
        Ok(if redo {c.after.clone()} else {c.before.clone()})
    }
    pub fn finish(&mut self, redo:bool) { if redo {if let Some(c)=self.redo.pop(){self.undo.push(c)}} else if let Some(c)=self.undo.pop(){self.redo.push(c)} }
}
pub fn journals()-> &'static Mutex<HashMap<String,Journal>> {static MAP:OnceLock<Mutex<HashMap<String,Journal>>>=OnceLock::new(); MAP.get_or_init(Default::default)}
pub fn content(mut value:Value)->Value { if let Some(o)=value.as_object_mut(){o.remove("updated");o.remove("revision");o.remove("_history");} value }
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn transactions(){let mut h=Journal::default();h.record(json!(1),json!(2),"Edit");assert_eq!(h.pending(false,&json!(2)).unwrap(),json!(1));assert!(h.pending(false,&json!(3)).is_err());h.finish(false);assert_eq!(h.pending(true,&json!(1)).unwrap(),json!(2));h.record(json!(1),json!(4),"New edit");assert!(h.pending(true,&json!(4)).is_err());}
}
