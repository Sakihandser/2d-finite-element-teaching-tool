// MFEM 4.10 reference excerpt; not a standalone compilation unit.
// Copyright (c) 2010-2026, Lawrence Livermore National Security, LLC.
// BSD-3-Clause. See ../LICENSE and ../NOTICE.

void GridFunction::ComputeFlux(BilinearFormIntegrator &blfi,
                               GridFunction &flux, bool wcoef,
                               int subdomain)
{
   Array<int> count(flux.Size());

   SumFluxAndCount(blfi, flux, count, wcoef, subdomain);

   // complete averaging
   for (int i = 0; i < count.Size(); i++)
   {
      if (count[i] != 0) { flux(i) /= count[i]; }
   }
}

