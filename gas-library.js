(function(root,factory){
  if(typeof module==="object" && module.exports)module.exports=factory(require("./blast-settings"));
  else root.GasLibrary=factory(root.BlastSettings);
})(typeof globalThis!=="undefined" ? globalThis : this,function(Settings){
  const fields=["airDensity","airPressure","airGamma","airEOS","airCovolume","airPressureOffset","airEnergyShift","airAttraction"];
  function entry(raw){
    if(!raw || typeof raw!=="object")throw new Error("Invalid gas record.");
    const id=String(raw.id || ""),name=String(raw.name || "").trim();
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !name || name.length>160)throw new Error("Invalid gas ID/name.");
    const settings={};
    for(const key of fields){const v=raw.settings?.[key]??(fields.indexOf(key)>=3?Settings.defaults[key]:undefined);if(typeof v!=="number" || !Number.isFinite(v))throw new Error(`Invalid gas parameter: ${key}`);settings[key]=v;}
    Settings.normalize({...settings,sourceMode:1});
    return {id,name,settings,notes:String(raw.notes || "").slice(0,12000),source:String(raw.source || "").slice(0,2000)};
  }
  function normalize(payload){
    if(!payload || !Array.isArray(payload.gases) || payload.gases.length>500 || !Number.isInteger(payload.revision) || payload.revision<0)throw new Error("Invalid gas library.");
    const gases=payload.gases.map(entry);
    if(new Set(gases.map(e=>e.id)).size!==gases.length)throw new Error("Duplicate gas IDs.");
    return {version:1,revision:payload.revision,gases};
  }
  function apply(current,raw){return Settings.normalize({...current,...entry(raw).settings});}
  return {fields,entry,normalize,apply};
});
