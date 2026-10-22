// FEMBLT02: 8 base scalars (+4 gas scalars when declared), u[2N], v[2N], cells[7E].
(function(root){
  const keys=["time","pressure","kineticEnergy","strainEnergy","externalWork","dissipatedEnergy","maxStress","maxDynamicStress"];
  const gasKeys=["gasInternalEnergy","gasKineticEnergy","gasWallWork","gasWallRadius"];
  const rockKeys=['plasticWork','crackVolume','gasStorageWork','maxStrain'];
  const diagnosticKeys=['actualSteps','minimumJacobian','gasRarefactionFallbacks','maximumCflRatio'];
  const ventKeys=['gasVentedMass','gasVentedEnergy','gasProductMass','gasAirMass'];
  function scalarCount(metadata={}) {const n=metadata.frameScalarCount ?? 8;if(![8,12,16,20,24].includes(n))throw new Error("Unsupported blast frame scalar count.");return n;}
  function cellCount(metadata={}){const n=metadata.cellScalarCount??7;if(![7,10].includes(n))throw new Error('Unsupported blast cell layout.');return n;}
  function frameBytes(metadata){
    const {nodeCount,elementCount}=metadata;
    if(!Number.isSafeInteger(nodeCount) || nodeCount<3 || !Number.isSafeInteger(elementCount) || elementCount<1)throw new Error("Invalid blast frame dimensions.");
    const bytes=(scalarCount(metadata)+4*nodeCount+cellCount(metadata)*elementCount)*8;
    if(bytes>256*1024*1024)throw new Error("Blast frame exceeds 256 MiB.");return bytes;
  }
  function decode(input,metadata,materialize=false){
    const bytes=input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
    if(bytes.byteLength!==frameBytes(metadata))throw new Error("Incomplete blast frame.");
    // Buffer slices need not be aligned. Copy only in that case.
    const aligned=bytes.byteOffset%8===0 ? bytes : bytes.slice();
    const values=new Float64Array(aligned.buffer,aligned.byteOffset,aligned.byteLength/8),result={};
    keys.forEach((key,i)=>result[key]=values[i]);
    const offset=scalarCount(metadata);
    if(offset>=12)gasKeys.forEach((key,i)=>result[key]=values[8+i]);
    if(offset>=16)rockKeys.forEach((key,i)=>result[key]=values[12+i]);
    if(offset>=20)diagnosticKeys.forEach((key,i)=>result[key]=values[16+i]);
    if(offset>=24)ventKeys.forEach((key,i)=>result[key]=values[20+i]);
    if([...keys,...(offset>=12 ? gasKeys : []),...(offset>=16?rockKeys:[]),...(offset>=20?diagnosticKeys:[]),...(offset>=24?ventKeys:[])].some(key=>!Number.isFinite(result[key])))throw new Error("Non-finite blast frame header.");
    const nd=2*metadata.nodeCount;
    result.u=values.subarray(offset,offset+nd);result.v=values.subarray(offset+nd,offset+2*nd);
    const nc=cellCount(metadata);result.elements=Array.from({length:metadata.elementCount},(_,i)=>values.subarray(offset+2*nd+nc*i,offset+2*nd+nc*i+nc));
    if(materialize){result.u=Array.from(result.u);result.v=Array.from(result.v);result.elements=result.elements.map(e=>Array.from(e));}
    return result;
  }
  function summary(bytes,metadata={}){const n=scalarCount(metadata),names=[...keys,...(n>=12?gasKeys:[]),...(n>=16?rockKeys:[]),...(n>=20?diagnosticKeys:[]),...(n>=24?ventKeys:[])];const view=new DataView(bytes.buffer,bytes.byteOffset,n*8);return Object.fromEntries(names.map((key,i)=>[key,view.getFloat64(i*8,true)]));}
  const api={frameBytes,decode,summary};
  if(typeof module!=="undefined" && module.exports)module.exports=api;else root.BlastFrameCodec=api;
})(typeof window!=="undefined" ? window : globalThis);
