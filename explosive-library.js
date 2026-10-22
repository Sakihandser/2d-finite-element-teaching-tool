// Shared persistent explosive records. Solver values are SI, including JWL
// specific internal energy (J/kg), not the tabulated volumetric E0 (J/m3).
(function(root,factory){
  if(typeof module==="object" && module.exports)module.exports=factory(require("./blast-settings"));
  else root.ExplosiveLibrary=factory(root.BlastSettings);
})(typeof globalThis!=="undefined" ? globalThis : this,function(Settings){
  "use strict";
  const fields=["productEOS","productDensity","productEnergy","productGamma","detonationVelocity","jwlA","jwlB","jwlR1","jwlR2","jwlOmega"];
  function entry(raw){
    if(!raw || typeof raw!=="object")throw new Error("Invalid explosive record.");
    const id=String(raw.id || ""),name=String(raw.name || "").trim();
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !name || name.length>160)throw new Error("Invalid explosive ID/name.");
    const settings={};
    for(const key of fields){if(typeof raw.settings?.[key]!=="number" || !Number.isFinite(raw.settings[key]))throw new Error(`Invalid explosive parameter: ${key}`);settings[key]=raw.settings[key];}
    Settings.normalize({...settings,sourceMode:1});
    if(raw.cjPressure!==null && raw.cjPressure!==undefined && !(typeof raw.cjPressure==="number" && Number.isFinite(raw.cjPressure) && raw.cjPressure>0))throw new Error("Invalid CJ pressure.");
    return {id,name,settings,cjPressure:raw.cjPressure ?? null,notes:String(raw.notes || "").slice(0,12000),source:String(raw.source || "").slice(0,2000)};
  }
  function normalize(payload){
    if(!payload || !Array.isArray(payload.explosives) || payload.explosives.length>500)throw new Error("Invalid explosive library.");
    const explosives=payload.explosives.map(entry);
    if(new Set(explosives.map(e=>e.id)).size!==explosives.length)throw new Error("Duplicate explosive IDs.");
    if(!Number.isInteger(payload.revision) || payload.revision<0)throw new Error("Invalid explosive library revision.");
    return {version:1,revision:payload.revision,explosives};
  }
  function apply(current,record){const e=entry(record);return Settings.normalize({...current,...e.settings,sourceMode:1});}
  return {fields,entry,normalize,apply};
});
