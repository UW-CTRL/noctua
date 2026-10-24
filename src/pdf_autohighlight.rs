//! Categorized paper highlights produced by a dedicated ephemeral analysis worker.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use crate::{App, library, pdf_agent, pdf_outline::normalized};

const PROMPT:&str=include_str!("prompts/pdf-autohighlight.md");
static GENERATION:tokio::sync::Mutex<()>=tokio::sync::Mutex::const_new(());

pub async fn generate(app:&App,key:&str)->Result<Value> {
    let _guard=GENERATION.lock().await;
    let analysis=if let Some(cached)=app.library.auto_highlights(key)? {cached}else{
        let index=app.library.index(key)?.context("Open this PDF in the reader to prepare its text first")?;
        let provider=app.settings.lock().unwrap().agent;
        let input=pdf_agent::input(&index,&app.library.paper(key)?["title"])?;
        let output=pdf_agent::complete(app,provider,PROMPT,&input).await?;
        let highlights=validate(&output,&index)?;
        json!({"version":1,"hash":index["hash"],"provider":provider.key(),"highlights":highlights})
    };
    let colors=app.settings.lock().unwrap().highlight_colors.clone();
    app.library.save_auto_highlights(key,&analysis,&colors)
}

fn validate(output:&str,index:&Value)->Result<Vec<Value>> {
    let data=pdf_agent::response(output)?;
    let entries=data["highlights"].as_array().context("The analysis is missing its highlight list")?;
    if entries.len()>48 {bail!("The analysis returned too many highlights (maximum 48)");}
    let pages=index["pages"].as_array().context("PDF text is not ready")?;
    let (mut result,mut ranges)=(Vec::new(),Vec::<(u64,usize,usize)>::new());
    for entry in entries {
        let category=entry["category"].as_str().unwrap_or("");
        let color=library::category_color(category).context("The analysis returned an unknown highlight category")?;
        let page=entry["page"].as_u64().filter(|p|*p>0&&*p<=pages.len() as u64).context("An auto-highlight points outside the PDF")?;
        let quote=normalized(entry["quote"].as_str().unwrap_or("")).0;
        if quote.chars().count()<8||quote.chars().count()>2000 {bail!("An auto-highlight must contain a concise source passage");}
        let comment=entry["comment"].as_str().unwrap_or("").trim();
        if comment.chars().count()>600 {bail!("An auto-highlight explanation is too long");}
        let occurrence=entry.get("occurrence").map(|v|v.as_u64().filter(|n|*n<10000).context("Invalid quote occurrence")).transpose()?.unwrap_or(0) as usize;
        let source=&pages[page as usize-1];let raw=source["text"].as_str().unwrap_or("");
        let (content,offsets)=normalized(raw);
        let start=content.match_indices(&quote).nth(occurrence).map(|(i,_)|i).context("An auto-highlight quote was not found on its stated page. Try again.")?;
        let end=start+quote.len();
        if ranges.iter().any(|(p,a,b)|*p==page&&start<*b&&end>*a) {continue;}
        let raw_start=offsets[start];let last=offsets[end-1];let raw_end=last+raw[last..].chars().next().unwrap().len_utf8();
        let exact=&raw[raw_start..raw_end];
        let exact_occurrence=raw[..raw_start].match_indices(exact).count();
        let rects=library::quote_rects(source,exact,exact_occurrence)?;
        result.push(json!({"kind":"highlight","category":category,"color":color,"page":page,"quote":exact,"occurrence":exact_occurrence,"rects":rects,"comment":comment,"source":"auto-highlight"}));
        ranges.push((page,start,end));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grounds_quotes_preserves_unicode_and_rejects_invalid_analysis() {
        let index=json!({"pages":[{"text":"α\nNovel method. Novel method.","words":[{"start":2,"end":7,"rect":[0.1,0.2,0.2,0.03]},{"start":8,"end":15,"rect":[0.3,0.2,0.2,0.03]},{"start":16,"end":21,"rect":[0.1,0.4,0.2,0.03]},{"start":22,"end":29,"rect":[0.3,0.4,0.2,0.03]}]}]});
        let good=json!({"highlights":[{"category":"method","page":1,"quote":"Novel method.","occurrence":1,"comment":"Core approach."}]});
        let result=validate(&good.to_string(),&index).unwrap();assert_eq!(result[0]["color"],"#5fb236");assert_eq!(result[0]["occurrence"],1);assert_eq!(result[0]["rects"][0][1],0.4);
        for patch in [json!({"category":"made-up"}),json!({"page":0}),json!({"quote":"Fabricated quote"}),json!({"occurrence":-1})] {
            let mut invalid=good.clone();for (k,v) in patch.as_object().unwrap(){invalid["highlights"][0][k]=v.clone();}
            assert!(validate(&invalid.to_string(),&index).is_err());
        }
        let mut duplicate=good.clone();duplicate["highlights"].as_array_mut().unwrap().push(good["highlights"][0].clone());
        assert_eq!(validate(&duplicate.to_string(),&index).unwrap().len(),1);
        let multiline=json!({"highlights":[{"category":"novelty","page":1,"quote":"α Novel method.","comment":"Contribution."}]});
        assert_eq!(validate(&multiline.to_string(),&index).unwrap()[0]["quote"],"α\nNovel method.");
    }
}
