#include "../../计算力学程序计算核心/RockConstitutive.h"
#include <iostream>
#include <iomanip>
using namespace fem::rock;
Parameters Card(){Parameters p;p.law=3;p.E=51.166364e9;p.nu=.168181818;p.ft=8e6;p.fc=150e6;p.h=.0015;p.gf=100;p.A=.76;p.N=.62;p.B=.25;p.M=.62;p.C=.005;p.rate0=1;p.HEL=4.5e9;p.pHEL=3.7e9;p.T=54e6;p.D1=.005;p.D2=.7;p.maxStrength=.25;p.K1=25.7e9;p.K2=-4500e9;p.K3=300000e9;return p;}
void Print(const State& s){std::cout<<"{\"q\":"<<Q(s.stress)<<",\"pressure\":"<<-s.stress.trace()/3<<",\"damage\":"<<s.damage<<",\"plasticStrain\":"<<s.plasticStrain<<",\"plasticWork\":"<<s.plasticWork<<",\"szz\":"<<s.stress(2,2)<<"}";}
int main(int argc,char** argv){try{const std::string mode=argc>1?argv[1]:"strength";auto p=Card();std::cout<<std::setprecision(16);
  if(mode=="strength"){std::cout<<"{\"sigmaHEL\":"<<p.SigmaHEL()<<",\"intact0\":"<<Intact(p,0,1)<<",\"intactConfined\":"<<Intact(p,100e6,1)<<",\"fast\":"<<Intact(p,100e6,1e5)<<",\"failed\":"<<Failed(p,100e6,1)<<",\"failureStrain\":"<<FailureStrain(p,100e6)<<"}";return 0;}
  State s;int n=argc>2?std::stoi(argv[2]):400;const double dt=1e-5/n;
  if(mode=="elastic"){p.law=1;Eigen::Vector3d e(.001,0,0);s=Advance(p,s,e,1e-5,false,false);std::cout<<"{\"sx\":"<<s.stress(0,0)<<",\"sy\":"<<s.stress(1,1)<<",\"szz\":"<<s.stress(2,2)<<"}";return 0;}
  if(mode=="plane-stress"){for(int i=1;i<=n;++i)s=Advance(p,s,Eigen::Vector3d(.003*i/n,0,0),dt,false,true);Print(s);return 0;}
  if(mode=="dp"){p.law=2;p.friction=35;p.dilation=0;}
  if(mode=="tension"){for(int i=0;i<n;++i)Step(p,s,Tensor::Identity()*(.01/n),dt,true);Print(s);return 0;}
  Tensor increment=Tensor::Zero();increment(0,0)=-.015/n;increment(1,1)=increment(2,2)=-.002/n;increment(0,1)=increment(1,0)=.01/n;
  for(int i=0;i<n;++i)Step(p,s,increment,dt,true);
  if(mode=="unload"){const double damage=s.damage,plastic=s.plasticStrain;for(int i=0;i<n;++i)Step(p,s,-increment*.1,dt,true);std::cout<<"{\"oldDamage\":"<<damage<<",\"oldPlastic\":"<<plastic<<",\"state\":";Print(s);std::cout<<"}";return 0;}
  Print(s);return 0;
}catch(const std::exception& ex){std::cerr<<ex.what();return 1;}}
