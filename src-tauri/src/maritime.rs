use serde_json::Value;
pub const ROOT: &str="https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services";
pub fn query(id:&str)->Result<(String,Vec<(String,String)>),String>{
 let (service,prefix,fields)=if id.starts_with("chokepoint") {("Daily_Chokepoints_Data","chokepoint","date,portid,portname,n_tanker,n_cargo,n_total,n_container,n_dry_bulk,n_general_cargo,n_roro")} else {("Daily_Ports_Data","port","date,portid,portname,portcalls_tanker,portcalls_cargo,portcalls,portcalls_container,portcalls_dry_bulk,portcalls_general_cargo,portcalls_roro")};
 let suffix=id.strip_prefix(prefix).ok_or("Invalid PortWatch identifier")?;
 if suffix.is_empty()||suffix.len()>6||!suffix.chars().all(|c|c.is_ascii_digit()){return Err("Invalid PortWatch identifier".into())}
 Ok((format!("{ROOT}/{service}/FeatureServer/0/query"),vec![("f".into(),"json".into()),("where".into(),format!("portid='{id}'")),("outFields".into(),fields.into()),("orderByFields".into(),"date DESC".into()),("resultRecordCount".into(),"90".into()),("returnGeometry".into(),"false".into())]))
}
/// PortWatch's ArcGIS host intermittently rejects valid queries with
/// "Invalid URL" (observed November 2026), so transient failures are retried.
pub async fn fetch(client:&reqwest::Client,id:&str)->Result<Value,String>{
 let mut last=String::new();
 for attempt in 0..6u64{
  if attempt>0{tokio::time::sleep(std::time::Duration::from_millis(800*attempt)).await;}
  match fetch_once(client,id).await{Ok(v)=>return Ok(v),Err((msg,retry))=>{last=msg;if !retry{break}}}
 }
 Err(last)
}
async fn fetch_once(client:&reqwest::Client,id:&str)->Result<Value,(String,bool)>{
 let (url,params)=query(id).map_err(|e|(e,false))?;
 let resp=client.get(url).query(&params).send().await.map_err(|_|("PortWatch connection failed".to_string(),true))?;
 if !resp.status().is_success(){return Err((format!("PortWatch HTTP {}",resp.status().as_u16()),true))}
 let data:Value=resp.json().await.map_err(|_|("Invalid PortWatch JSON".to_string(),true))?;
 if data.get("error").is_some(){return Err(("PortWatch is busy and refused the request. Try again shortly.".to_string(),true))}
 let features=data["features"].as_array().ok_or(("PortWatch response missing features".to_string(),false))?;
 if features.len()>90{return Err(("Unexpected PortWatch response size".to_string(),false))}
 for f in features {if f["attributes"]["portid"].as_str()!=Some(id){return Err(("PortWatch returned a mismatched location".to_string(),false))}}
 Ok(data)
}
#[cfg(test)]mod tests{use super::*;#[test]fn validates_ids(){for id in ["port1' OR 1=1","http://localhost","port","chokepoint-1","port1234567"]{assert!(query(id).is_err())}assert!(query("port1114").is_ok());}#[test]fn selects_correct_schema(){let(u,p)=query("chokepoint6").unwrap();assert!(u.contains("Daily_Chokepoints_Data"));assert!(p.iter().any(|(k,v)|k=="outFields"&&v.contains("n_tanker")));assert!(p.iter().any(|(k,v)|k=="resultRecordCount"&&v=="90"));}}

#[cfg(test)] mod contract_tests {
 #[test] #[ignore = "Explicit live-provider contract check; requires network"]
 fn live_portwatch_contract(){let rt=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();rt.block_on(async {let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap();let data=super::fetch(&client,"chokepoint6").await.unwrap();assert!(!data["features"].as_array().unwrap().is_empty());assert!(data["features"][0]["attributes"].get("n_tanker").is_some());});}
}
