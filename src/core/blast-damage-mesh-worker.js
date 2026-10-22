importScripts('../../blast-fracture.js','./adaptive-mesh.js','./blast-damage-mesh.js');
self.onmessage=({data})=>{
  try{
    const result=BlastDamageMesh.prepare(data.nodes,data.elements,data.properties,data.settings,{
      boundarySegments:data.boundarySegments,onProgress:progress=>self.postMessage({progress})
    });
    self.postMessage({result});
  }catch(error){self.postMessage({error:error.message || String(error)});}
};
