//! Renewable update lease and acknowledgments from connected editor shells.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};
#[derive(Default)]
pub(crate) struct Maintenance {
    clients: HashMap<String, Instant>,
    pending: Option<Pending>,
}
struct Pending {
    id: String,
    version: String,
    phase: &'static str,
    expires: Instant,
    required: HashSet<String>,
    acknowledged: HashSet<String>,
    blocked: HashSet<String>,
}
impl Maintenance {
    pub fn expire(&mut self) -> bool {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.expires < Instant::now())
        {
            self.pending = None;
            return true;
        }
        false
    }
    pub fn touch(&mut self, id: &str) {
        if id.len() > 128
            || id.is_empty()
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return;
        }
        self.clients
            .retain(|_, at| at.elapsed() < Duration::from_secs(45));
        if self.clients.len() < 1024 || self.clients.contains_key(id) {
            self.clients.insert(id.into(), Instant::now());
        }
        if let Some(p) = &mut self.pending {
            if p.phase == "announcing" {
                p.required.insert(id.into());
            }
        }
    }
    pub fn notice(&self) -> Value {
        self.pending.as_ref().map(|p|json!({"id":p.id,"version":p.version,"phase":p.phase,"waiting_clients":p.required.difference(&p.acknowledged).count(),"blocked_clients":p.blocked.len()})).unwrap_or(Value::Null)
    }
    pub fn control(&mut self, action: &str, id: &str, version: &str) -> anyhow::Result<Value> {
        self.expire();
        match action {
            "begin" => {
                anyhow::ensure!(
                    self.pending.as_ref().is_none_or(|p| p.id == id),
                    "Another update has already notified clients"
                );
                if self.pending.is_none() {
                    let required = self
                        .clients
                        .iter()
                        .filter(|(_, at)| at.elapsed() < Duration::from_secs(30))
                        .map(|(id, _)| id.clone())
                        .collect();
                    self.pending = Some(Pending {
                        id: id.into(),
                        version: version.into(),
                        phase: "announcing",
                        expires: Instant::now() + Duration::from_secs(30),
                        required,
                        acknowledged: HashSet::new(),
                        blocked: HashSet::new(),
                    });
                }
            }
            "heartbeat" | "drain" | "cancel" => {
                let clients = &self.clients;
                let p = self
                    .pending
                    .as_mut()
                    .filter(|p| p.id == id)
                    .ok_or_else(|| {
                        anyhow::anyhow!("Update lease expired or belongs to another transaction")
                    })?;
                p.expires = Instant::now() + Duration::from_secs(30);
                if action == "drain" {
                    // A desktop installer closes its old editor shells. Once their
                    // presence lease expires, they must not strand the new release.
                    p.required.retain(|client| {
                        clients
                            .get(client)
                            .is_some_and(|seen| seen.elapsed() < Duration::from_secs(30))
                    });
                    p.blocked.retain(|client| p.required.contains(client));
                    anyhow::ensure!(p.blocked.is_empty(),"A connected editor could not save. Resolve its edits/conflicts before retrying the update");
                    anyhow::ensure!(p.required.is_subset(&p.acknowledged),"A connected client has not confirmed its saved edits. Reconnect or close that client, then retry");
                    p.phase = "draining";
                }
                if action == "cancel" {
                    self.pending = None;
                }
            }
            _ => anyhow::bail!("Unknown server update action"),
        }
        Ok(self.notice())
    }
    pub fn acknowledge(&mut self, id: &str, client: &str, saved: bool) -> anyhow::Result<()> {
        let p = self
            .pending
            .as_mut()
            .filter(|p| p.id == id)
            .ok_or_else(|| anyhow::anyhow!("Update is no longer pending"))?;
        anyhow::ensure!(p.required.contains(client), "Unknown editor session");
        if saved {
            p.acknowledged.insert(client.into());
            p.blocked.remove(client);
        } else {
            p.blocked.insert(client.into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_editor_expires_but_connected_unsaved_editor_blocks_replacement() {
        let mut m = Maintenance::default();
        m.touch("closed");
        m.touch("live");
        m.control("begin", "update", "2.0.0").unwrap();
        m.clients
            .insert("closed".into(), Instant::now() - Duration::from_secs(31));
        assert!(m.control("drain", "update", "").is_err());
        m.acknowledge("update", "live", true).unwrap();
        assert!(m.control("drain", "update", "").is_ok());
    }
    #[test]
    fn update_waits_for_every_editor_and_rejects_foreign_transactions() {
        let mut m = Maintenance::default();
        m.touch("editor-a");
        m.touch("editor-b");
        m.control("begin", "update", "2.0.0").unwrap();
        m.acknowledge("update", "editor-a", true).unwrap();
        assert!(m.control("drain", "update", "").is_err());
        m.acknowledge("update", "editor-b", false).unwrap();
        assert!(m.control("drain", "update", "").is_err());
        m.acknowledge("update", "editor-b", true).unwrap();
        assert_eq!(
            m.control("drain", "update", "").unwrap()["phase"],
            "draining"
        );
        assert!(m.control("cancel", "foreign", "").is_err());
        m.pending.as_mut().unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert!(m.expire());
        assert!(m.notice().is_null());
    }
}
