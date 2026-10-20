// 当前显示的主页面。
function currentPageKey() {
  const activePage = pageViews.find((viewElement) => !viewElement.hidden);
  return activePage?.dataset.page || "home";
}

// 切换顶部页签对应的功能页；绘图页和计算页各自刷新自己的 canvas 尺寸。
function setPage(page) {
  closeShapeEditor();
  const nextPage = ["calculation", "results", "materials", "training"].includes(page) ? page : "home";
  document.body.classList.toggle("training-active", nextPage === "training");
  if (window.history?.replaceState && window.location && (nextPage === "training" || window.location.hash === "#training")) {
    window.history.replaceState(null, "", nextPage === "training" ? "#training" : window.location.pathname + window.location.search);
  }
  hideRegionMaterialMenu();
  if (nextPage !== "calculation") {
    cancelCalculationAnimationFrame();
  }
  pageTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.pageTab === nextPage);
  });
  pageViews.forEach((viewElement) => {
    const isActive = viewElement.dataset.page === nextPage;
    viewElement.hidden = !isActive;
    viewElement.classList.toggle("active", isActive);
  });
  if (nextPage === "home") {
    requestAnimationFrame(resizeCanvas);
  }
  if (nextPage === "calculation") {
    requestAnimationFrame(() => {
      resizeCalculationCanvas();
      renderCalculationView();
    });
  }
  if (nextPage === "results") {
    requestAnimationFrame(() => {
      resizeResultCanvas();
      loadCalculationResultsFromProjectFolder({ quietMissing: true });
    });
  }
  if (nextPage === "materials") {
    renderMaterialLibrary();
  }
  if (nextPage === "training" && window.trainingDashboard) window.trainingDashboard.refresh();
}
