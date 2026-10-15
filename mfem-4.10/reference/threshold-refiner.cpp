// MFEM 4.10 reference excerpt; not a standalone compilation unit.
// Copyright (c) 2010-2026, Lawrence Livermore National Security, LLC.
// BSD-3-Clause. See ../LICENSE and ../NOTICE.

ThresholdRefiner::ThresholdRefiner(ErrorEstimator &est)
   : estimator(est)
{
   aniso_estimator = dynamic_cast<AnisotropicErrorEstimator*>(&estimator);
   total_norm_p = infinity();
   total_err_goal = 0.0;
   total_fraction = 0.5;
   local_err_goal = 0.0;
   max_elements = std::numeric_limits<long long>::max();

   threshold = 0.0;
   num_marked_elements = 0LL;

   non_conforming = -1;
   nc_limit = 0;
}

real_t ThresholdRefiner::GetNorm(const Vector &local_err, Mesh &mesh) const
{
#ifdef MFEM_USE_MPI
   ParMesh *pmesh = dynamic_cast<ParMesh*>(&mesh);
   if (pmesh)
   {
      return ParNormlp(local_err, total_norm_p, pmesh->GetComm());
   }
#endif
   return local_err.Normlp(total_norm_p);
}

int ThresholdRefiner::MarkWithoutRefining(Mesh & mesh,
                                          Array<Refinement> & refinements)
{
   threshold = 0.0;
   num_marked_elements = 0LL;
   refinements.SetSize(0);

   const long long num_elements = mesh.GetGlobalNE();
   if (num_elements >= max_elements) { return STOP; }

   const int NE = mesh.GetNE();
   const Vector &local_err = estimator.GetLocalErrors();
   MFEM_ASSERT(local_err.Size() == NE, "invalid size of local_err");

   const real_t total_err = GetNorm(local_err, mesh);
   if (total_err <= total_err_goal) { return STOP; }

   if (total_norm_p < infinity())
   {
      threshold = std::max((real_t) (total_err * total_fraction *
                                     std::pow(num_elements, -1.0/total_norm_p)),
                           local_err_goal);
   }
   else
   {
      threshold = std::max(total_err * total_fraction, local_err_goal);
   }

   for (int el = 0; el < NE; el++)
   {
      if (local_err(el) > threshold)
      {
         refinements.Append(Refinement(el));
      }
   }

   if (aniso_estimator)
   {
      const Array<int> &aniso_flags = aniso_estimator->GetAnisotropicFlags();
      if (aniso_flags.Size() > 0)
      {
         for (int i = 0; i < refinements.Size(); i++)
         {
            Refinement &ref = refinements[i];
            ref.SetType(aniso_flags[ref.index]);
         }
      }
   }

   return NONE;
}

int ThresholdRefiner::ApplyImpl(Mesh &mesh)
{
   const int action = MarkWithoutRefining(mesh, marked_elements);
   if (action == STOP) { return STOP; }

   num_marked_elements = mesh.ReduceInt(marked_elements.Size());
   if (num_marked_elements == 0LL) { return STOP; }

   mesh.GeneralRefinement(marked_elements, non_conforming, nc_limit);
   return static_cast<int>(CONTINUE) + static_cast<int>(REFINED);
}

