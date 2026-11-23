(function () {
  "use strict";
  var script = document.currentScript;
  var LABEL = (script && script.dataset.copy) || "Copy";
  var DONE = (script && script.dataset.copied) || "Copied";

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy") ? resolve() : reject(new Error("copy failed"));
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  function wireButton(btn, getText) {
    var timer;
    btn.addEventListener("click", function () {
      copyText(getText()).then(function () {
        btn.textContent = DONE;
        btn.classList.add("done");
        clearTimeout(timer);
        timer = setTimeout(function () {
          btn.textContent = LABEL;
          btn.classList.remove("done");
        }, 1800);
      });
    });
  }

  document.querySelectorAll("[data-copy-text]").forEach(function (btn) {
    wireButton(btn, function () {
      return btn.getAttribute("data-copy-text");
    });
  });

  document.querySelectorAll(".prose pre, .tabs pre").forEach(function (pre) {
    var wrap = document.createElement("div");
    wrap.className = "codeblock";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = LABEL;
    wrap.appendChild(btn);
    wireButton(btn, function () {
      return pre.innerText.replace(/\n$/, "");
    });
  });

  document.querySelectorAll("[data-tabs]").forEach(function (root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        select(tab, false);
      });
      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (next) {
          e.preventDefault();
          select(next, true);
        }
      });
    });
  });
})();
