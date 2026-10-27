#include "../../TensoraCore/RockConstitutive.h"
#include <iostream>
#include <iomanip>
using namespace fem::rock;
Parameters Base(int law,std::vector<double> values){Parameters p;p.law=law;p.E=210e9;p.nu=.3;p.solid=values;PrepareSolid(p,law==8||law==13,true,7800);return p;}
void Number(const char* key,double value,bool comma=true){std::cout<<'"'<<key<<"\":"<<value<<(comma?",":"");}
Tensor Shear(double gamma){Tensor t=Tensor::Zero();t(0,1)=t(1,0)=gamma/2;return t;}
int main(int argc,char** argv){try{std::cout<<std::setprecision(16)<<"{";const std::string mode=argc>1?argv[1]:"j2";const int n=argc>2?std::stoi(argv[2]):200;
  if(mode=="j2"||mode=="perzyna"){
    auto p=Base(mode=="j2"?4:11,mode=="j2"?std::vector<double>{200e6,1e9}:std::vector<double>{200e6,1e9,.001,2});State s;Step(p,s,Shear(.02),.001,false);
    Number("q",Q(s.stress));Number("ep",s.plasticStrain);Number("work",s.plasticWork);Number("energy",StoredEnergy(p,s));
    const double ep=s.plasticStrain;Step(p,s,Shear(-1e-5),1e-6,false);Number("unloadEp",s.plasticStrain);Number("oldEp",ep);
    State plane;plane=Advance(p,plane,Eigen::Vector3d(.004,0,.001),.001,false,false);Number("szz",plane.stress(2,2),false);
  }else if(mode=="jc"||mode=="jc-adiabatic"){
    auto p=Base(5,{200e6,400e6,.4,.02,1,1,293,1700,293,480,mode=="jc"?0.:.9});State s;s.temperature=293;
    if(mode=="jc")Step(p,s,Shear(.02),.00001,false);else for(int i=0;i<n;i++)Step(p,s,Shear(.2/n),.001/n,false);
    Number("q",Q(s.stress));Number("ep",s.plasticStrain);Number("temperature",s.temperature);Number("work",s.plasticWork,false);
  }else if(mode=="mc"){
    auto p=Base(6,{5e6,30,5,1e6});State s;s.stress=-10e6*Tensor::Identity();
    for(int i=0;i<n;i++){Tensor e=Tensor::Zero();e(0,0)=-.004/n;e(1,1)=.001/n;e(0,1)=e(1,0)=.002/n;Step(p,s,e,.001/n,false);}
    Eigen::SelfAdjointEigenSolver<Tensor> eig(s.stress);const auto a=eig.eigenvalues();Number("min",a[0]);Number("max",a[2]);Number("work",s.plasticWork);Number("ep",s.plasticStrain);
    State tension;Step(p,tension,.01*Tensor::Identity(),.001,false);Number("apexMax",tension.stress.eigenvalues().real().maxCoeff());
    const Tensor r=Orientation(37);State rotated,plain;Tensor e=Tensor::Zero();e(0,0)=-.003;e(1,1)=-.0002;e(0,1)=e(1,0)=.002;
    Step(p,plain,e,.001,false);Step(p,rotated,r*e*r.transpose(),.001,false);Number("rotationError",(rotated.stress-r*plain.stress*r.transpose()).norm()/std::max(1.,plain.stress.norm()),false);
  }else if(mode=="maxwell"){
    auto p=Base(7,{.3,.02,.2,.1,0,0,0,0});State s;Step(p,s,Shear(.01),.01,false);Number("rampShear",s.stress(0,1));const double before=StoredEnergy(p,s),loss=s.plasticWork;
    Step(p,s,Tensor::Zero(),.05,false);Number("holdShear",s.stress(0,1));Number("holdLoss",s.plasticWork-loss);Number("energyDrop",before-StoredEnergy(p,s));
    State plane;plane=Advance(p,plane,Eigen::Vector3d(.001,0,.001),.02,false,false);Number("szz",plane.stress(2,2),false);
  }else if(mode=="mcc-shear"){
    auto p=Base(9,{1.2,.2,.04,.8,250e3});p.E=20e6;p.nu=.3;State s;s.pc=250e3;s.stress=-100e3*Tensor::Identity();
    for(int i=0;i<n;i++)Step(p,s,Shear(.15/n),.001/n,false);
    Number("p",-s.stress.trace()/3);Number("q",Q(s.stress));Number("pc",s.pc);Number("work",s.plasticWork,false);
  }else if(mode=="mcc"){
    auto p=Base(9,{1.2,.2,.04,.8,200e3});p.E=20e6;p.nu=.3;State s;s.pc=200e3;s.stress=-100e3*Tensor::Identity();
    const Tensor e=-.02/3*Tensor::Identity();Step(p,s,e,.001,false);Number("p",-s.stress.trace()/3);Number("pc",s.pc);Number("plasticVolume",s.plasticVolume);Number("work",s.plasticWork,false);
  }else if(mode=="cap"){
    auto p=Base(10,{5e6,30,5,20e6,2,500e6});p.E=2e9;p.nu=.25;State s;for(int i=0;i<n;i++)Step(p,s,-.1/(3*n)*Tensor::Identity(),.001/n,false);
    const double pa=p.solid[3]+p.solid[5]*s.plasticVolume;Number("p",-s.stress.trace()/3);Number("pa",pa);Number("plasticVolume",s.plasticVolume);Number("work",s.plasticWork,false);
  }else if(mode=="orthotropic"){
    auto p=Base(12,{100e9,20e9,10e9,.2,.1,.15,8e9,4e9,5e9,0});const double stress=10e6;Tensor strain=Tensor::Zero();strain(0,0)=stress/100e9;strain(1,1)=-.2*stress/100e9;strain(2,2)=-.15*stress/100e9;
    State s;Step(p,s,strain,.001,false);Number("sx",s.stress(0,0));Number("sy",s.stress(1,1));Number("sz",s.stress(2,2));
    auto pr=p;pr.solid[9]=37;State sr;const Tensor r=Orientation(37);Step(pr,sr,r*strain*r.transpose(),.001,false);Number("rotationError",(sr.stress-r*s.stress*r.transpose()).norm()/stress);
    State plane;plane=Advance(pr,plane,Eigen::Vector3d(.001,0,.001),.001,false,false);Number("szz",plane.stress(2,2),false);
  }else if(mode=="neo"||mode=="mooney"){
    auto p=mode=="neo"?Base(8,{2e6,100e6}):Base(13,{.7e6,.3e6,100e6});Tensor F=Tensor::Identity();F(0,0)=1.4;F(1,1)=1/1.4;State s=AdvanceHyperelastic(p,State{},F);
    Number("sx",s.stress(0,0));Number("sy",s.stress(1,1));Number("energy",StoredEnergy(p,s));
    const Tensor r=Orientation(49);State rotated=AdvanceHyperelastic(p,State{},r*F);Number("rotationError",(rotated.stress-r*s.stress*r.transpose()).norm()/s.stress.norm());
    const double h=1e-6;Tensor plus=F,minus=F;plus(0,0)+=h;minus(0,0)-=h;const double fd=(AdvanceHyperelastic(p,State{},plus).solidEnergy-AdvanceHyperelastic(p,State{},minus).solidEnergy)/(2*h);const Tensor piola=F.determinant()*s.stress*F.inverse().transpose();Number("energyDerivativeError",std::abs(fd/piola(0,0)-1));
    Number("rigidStress",AdvanceHyperelastic(p,State{},r).stress.norm(),false);
  }else if(mode=="hjc"){
    auto p=Base(14,{.79,1.6,.61,.007,1,48e6,4e6,7,.04,1,.001,16e6,.001,800e6,.1,85e9,-171e9,208e9});p.logarithmicVolume=false;State s;
    for(int i=0;i<n;i++)Step(p,s,-.05/(3*n)*Tensor::Identity(),.001/n,true);
    const double oldDamage=s.damage,oldVolume=s.plasticVolume;Number("pressure",-s.stress.trace()/3);Number("damage",s.damage);Number("plasticVolume",oldVolume);Number("work",s.plasticWork);
    Step(p,s,.003*Tensor::Identity(),.001,true);Number("unloadDamage",s.damage);Number("unloadPlasticVolume",s.plasticVolume);Number("unloadPressure",-s.stress.trace()/3);
    const double before=s.damage,work=s.plasticWork,pressure=-s.stress.trace()/3;for(int i=0;i<10;i++)Step(p,s,Tensor::Zero(),.001,true);
    Number("holdDamageChange",s.damage-before);Number("holdWorkChange",s.plasticWork-work);Number("holdPressureChange",-s.stress.trace()/3-pressure,false);
  }else if(mode=="mc-random"){
    auto p=Base(6,{5e6,30,0,1e6});double maxViolation=0,rotationError=0;unsigned random=12345;
    for(int i=0;i<300;i++){Tensor e=Tensor::Zero();for(int a=0;a<3;a++)for(int b=a;b<3;b++){random=1664525*random+1013904223;e(a,b)=e(b,a)=(double(random)/4294967296.-.5)*.01;}
      State s;Step(p,s,e,.001,false);Eigen::SelfAdjointEigenSolver<Tensor> eig(s.stress);auto a=eig.eigenvalues();maxViolation=std::max(maxViolation,std::max(1.5*a[2]-.5*a[0]-10e6*std::cos(3.141592653589793/6),a[2]-1e6));}
    Number("violation",maxViolation,false);
  }else throw std::runtime_error("unknown mode");
  std::cout<<"}";return 0;
}catch(const std::exception& e){std::cerr<<e.what();return 1;}}
