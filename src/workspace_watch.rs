//! Filesystem events are invalidation hints, never authorization or write revisions.
use crate::{ApiResult, App, Shared};
use axum::{
    extract::{Path, State},
    Json,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

struct Subscription {
    _watcher: Option<RecommendedWatcher>,
    epoch: String,
    generation: Arc<AtomicU64>,
    healthy: Arc<AtomicBool>,
    touched: Instant,
}
static WATCHES: OnceLock<Mutex<HashMap<PathBuf, Subscription>>> = OnceLock::new();
fn token(app: &App, target: &str) -> anyhow::Result<serde_json::Value> {
    let linked = crate::linked::is_linked(target);
    let root = if linked {
        crate::linked::root(app, target)?
    } else {
        let p = crate::workspace::dir(app, target)?;
        std::fs::create_dir_all(&p)?;
        p
    }
    .canonicalize()?;
    let mut watches = WATCHES.get_or_init(Default::default).lock().unwrap();
    watches.retain(|_, s| s.touched.elapsed() < Duration::from_secs(120));
    if !watches.contains_key(&root) {
        if watches.len() >= 64 {
            if let Some(old) = watches
                .iter()
                .min_by_key(|(_, s)| s.touched)
                .map(|(p, _)| p.clone())
            {
                watches.remove(&old);
            }
        }
        let generation = Arc::new(AtomicU64::new(0));
        let healthy = Arc::new(AtomicBool::new(true));
        let (counter, health, base) = (generation.clone(), healthy.clone(), root.clone());
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            match event {
                Ok(event) => {
                    if matches!(event.kind, notify::EventKind::Access(_)) {
                        return;
                    }
                    // Compiler outputs are disposable and must not invalidate source trees.
                    if !linked
                        && !event.paths.is_empty()
                        && event.paths.iter().all(|p| {
                            p.strip_prefix(&base).is_ok_and(|p| {
                                p.starts_with(".workspace/paper")
                                    || p.starts_with(".workspace/linked")
                            })
                        })
                    {
                        return;
                    }
                    counter.fetch_add(1, Ordering::Relaxed);
                }
                Err(_) => {
                    health.store(false, Ordering::Relaxed);
                    counter.fetch_add(1, Ordering::Relaxed);
                }
            }
        })
        .and_then(|mut watcher| {
            watcher.watch(&root, RecursiveMode::Recursive)?;
            Ok(watcher)
        })
        .ok();
        if watcher.is_none() {
            healthy.store(false, Ordering::Relaxed);
        }
        watches.insert(
            root.clone(),
            Subscription {
                _watcher: watcher,
                epoch: uuid::Uuid::new_v4().to_string(),
                generation,
                healthy,
                touched: Instant::now(),
            },
        );
    }
    let subscription = watches.get_mut(&root).unwrap();
    subscription.touched = Instant::now();
    Ok(
        json!({"generation":format!("{}:{}",subscription.epoch,subscription.generation.load(Ordering::Relaxed)),"watching":subscription.healthy.load(Ordering::Relaxed)}),
    )
}
pub async fn changes(State(app): Shared, Path(target): Path<String>) -> ApiResult {
    Ok(Json(
        tokio::task::spawn_blocking(move || token(&app, &target)).await??,
    ))
}
