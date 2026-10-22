const fs=require("node:fs/promises"),path=require("node:path"),{randomUUID}=require("node:crypto");
const Library=require("./explosive-library");
function createParameterStore(directory,normalize){
  const file=path.join(directory,"library.json");let pending=Promise.resolve();
  const read=async()=>normalize(JSON.parse(await fs.readFile(file,"utf8")));
  function save(input){
    const operation=pending.then(async()=>{
      const next=normalize(input),current=await read();
      if(next.revision!==current.revision){const e=new Error("Parameter library changed in another window. Reload before saving.");e.statusCode=409;throw e;}
      next.revision++;
      const temp=path.join(directory,`.library-${randomUUID()}.tmp`);
      try{await fs.writeFile(temp,JSON.stringify(next,null,2)+"\n","utf8");await fs.rename(temp,file);}
      finally{await fs.rm(temp,{force:true});}
      return next;
    });
    pending=operation.catch(()=>{});return operation;
  }
  return {read,save};
}
const createExplosiveStore=directory=>createParameterStore(directory,Library.normalize);
module.exports={createExplosiveStore,createParameterStore};
