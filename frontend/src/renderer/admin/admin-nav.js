"use strict";
// Highlight the side-menu link of the section currently in view.
(function () {
    const links = [...document.querySelectorAll(".side a[data-section]")];
    const visible = new Map();
    let pageOpen = false;
    document.addEventListener("kei:admin-page", event => { pageOpen = event.detail.open; mark(); });
    function mark() {
        let best = null;
        // While a plugin page is open and on screen, the side entry is the current item.
        if (pageOpen && (visible.get("plugin-page") || 0) > 0) { for (const link of links) link.removeAttribute("aria-current"); return; }
        for (const link of links) {
            const ratio = visible.get(link.dataset.section) || 0;
            if (ratio > 0 && (!best || ratio > best.ratio)) best = { link, ratio };
        }
        for (const link of links) {
            if (best && link === best.link) link.setAttribute("aria-current", "true"); else link.removeAttribute("aria-current");
        }
    }
    const observer = new IntersectionObserver(items => {
        for (const item of items) visible.set(item.target.id, item.isIntersecting ? item.intersectionRatio : 0);
        mark();
    }, { threshold: [0, .15, .35, .6, .9] });
    for (const link of links) {
        const section = document.getElementById(link.dataset.section);
        if (section) observer.observe(section);
    }
    const page = document.getElementById("plugin-page");
    if (page) observer.observe(page);
    window.kei?.onFocusSection?.(sectionId => {
        const target = typeof sectionId === "string" ? document.getElementById(sectionId) : null;
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
})();
