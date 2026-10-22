// 当前显示的主页面。
function currentPageKey() {
  const activePage = pageViews.find((viewElement) => !viewElement.hidden);
  return activePage?.dataset.page || "home";
}

// 切换顶部页签对应的功能页；绘图页和计算页各自刷新自己的 canvas 尺寸。
function setPage(page) {
  closeShapeEditor();
  const previousPage = currentPageKey();
  let nextPage = ["calculation", "results", "materials", "blast-library", "blast", "blast-results"].includes(page) ? page : "home";
  if (["blast-library", "blast", "blast-results"].includes(nextPage) && !isProfessionalCalculationEnabled("blast")) nextPage = "calculation";
  if (["results", "blast-results"].includes(nextPage)) activateResultWorkspace(nextPage === "results" ? "static" : "blast");
  if (nextPage !== "blast-results" && typeof blastPlayback !== "undefined" && blastPlayback !== null) {
    cancelAnimationFrame(blastPlayback); blastPlayback = null;
  }
  if (previousPage === "blast-results" && nextPage !== "blast-results" && typeof blastHistory !== "undefined" && blastHistory) {
    blastHistory.displayController?.abort(); blastLoadTicket++;
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
  if (nextPage === "blast") {
    document.getElementById("blastMaxAnalysisNodes").value = maxAnalysisNodes.value;
    requestAnimationFrame(renderBlastSetup);
  }
  if (nextPage === "blast-results") {
    requestAnimationFrame(() => { resizeResultCanvas(); renderResultView(); });
  }
  if (nextPage === "blast-library") renderBlastLibrary();
  if (nextPage === "materials") {
    renderMaterialLibrary();
  }
}
