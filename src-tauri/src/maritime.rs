use serde_json::Value;
pub const ROOT: &str="https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services";
pub fn query(id:&str)->Result<(String,Vec<(String,String)>),String>{
 let (service,prefix,fields)=if id.starts_with("chokepoint") {("Daily_Chokepoints_Data","chokepoint","date,portid,portname,n_tanker,n_cargo,n_total,n_container,n_dry_bulk,n_general_cargo,n_roro")} else {("Daily_Ports_Data","port","date,portid,portname,portcalls_tanker,portcalls_cargo,portcalls,portcalls_container,portcalls_dry_bulk,portcalls_general_cargo,portcalls_roro")};
 let suffix=id.strip_prefix(prefix).ok_or("Invalid PortWatch identifier")?;
 if suffix.is_empty()||suffix.len()>6||!suffix.chars().all(|c|c.is_ascii_digit()){return Err("Invalid PortWatch identifier".into())}
 Ok((format!("{ROOT}/{service}/FeatureServer/0/query"),vec![("f".into(),"json".into()),("where".into(),format!("portid = '{id}'")),("outFields".into(),fields.into()),("orderByFields".into(),"date DESC".into()),("resultRecordCount".into(),"90".into()),("returnGeometry".into(),"false".into())]))
}
pub async fn fetch(client:&reqwest::Client,id:&str)->Result<Value,String>{let (url,params)=query(id)?;let resp=client.get(url).query(&params).send().await.map_err(|_|"PortWatch connection failed")?;if !resp.status().is_success(){return Err(format!("PortWatch HTTP {}",resp.status().as_u16()))}let data:Value=resp.json().await.map_err(|_|"Invalid PortWatch JSON")?;if data.get("error").is_some(){return Err("PortWatch returned a service error".into())}let features=data["features"].as_array().ok_or("PortWatch response missing features")?;if features.len()>90{return Err("Unexpected PortWatch response size".into())}for f in features {if f["attributes"]["portid"].as_str()!=Some(id){return Err("PortWatch returned a mismatched location".into())}}Ok(data)}
#[cfg(test)]mod tests{use super::*;#[test]fn validates_ids(){for id in ["port1' OR 1=1","http://localhost","port","chokepoint-1","port1234567"]{assert!(query(id).is_err())}assert!(query("port1114").is_ok());}#[test]fn selects_correct_schema(){let(u,p)=query("chokepoint6").unwrap();assert!(u.contains("Daily_Chokepoints_Data"));assert!(p.iter().any(|(k,v)|k=="outFields"&&v.contains("n_tanker")));assert!(p.iter().any(|(k,v)|k=="resultRecordCount"&&v=="90"));}}

#[cfg(test)] mod contract_tests {
 #[test] #[ignore = "Explicit live-provider contract check; requires network"]
 fn live_portwatch_contract(){let rt=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();rt.block_on(async {let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap();let data=super::fetch(&client,"chokepoint6").await.unwrap();assert!(!data["features"].as_array().unwrap().is_empty());assert!(data["features"][0]["attributes"].get("n_tanker").is_some());});}
}
