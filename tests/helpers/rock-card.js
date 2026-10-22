// Numerical verification data only; not a material preset shipped to users.
function rockCard(T=54e6){
 return {law:3,jh2:{A:.76,N:.62,B:.25,M:.62,C:.005,rate0:1,HEL:4.5e9,pHEL:3.7e9,T,
  D1:.005,D2:.7,maxStrength:.25,K1:25.7e9,K2:-4500e9,K3:300000e9,beta:0,referenceLength:0,normalizationStress:4.5e9}};
}
module.exports={rockCard};
