// 保留原有分组和控件，只把分组标题变为可用鼠标或键盘操作的折叠按钮。
function initializeSidebarPanels() {
  document.querySelectorAll(".tool-panel > .panel-section, .inspector-panel > .panel-section").forEach((section) => {
    const heading = section.querySelector("h2");
    if (!heading || heading.querySelector(".panel-collapse-button")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "panel-collapse-button";
    button.setAttribute("aria-expanded", "true");
    while (heading.firstChild) button.appendChild(heading.firstChild);
    heading.appendChild(button);
    button.addEventListener("click", () => {
      const collapsed = section.classList.toggle("is-collapsed");
      button.setAttribute("aria-expanded", String(!collapsed));
    });
  });
}
