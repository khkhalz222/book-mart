(function () {
  "use strict";
  
  // ==========================================
  // GLOBAL VARIABLES & HELPERS
  // ==========================================
  var messageEl = document.getElementById("admin-message");
  var currentView = document.body.getAttribute("data-initial-view") || "dashboard";
  var materialPickers = [];
  var drinkRowsCache = [];
  var recipeRowStates = [];
  var materialNamePicker = null;
  var allCategoriesCache = [];
  var employeesCache = [];
  var editingMaterial = false;

  if (!window.allMaterialsCache) window.allMaterialsCache = [];
  
  // Format number with commas and 2 decimal places: 10000 -> 10,000.00
  function formatMoney(value) {
    if (value === null || value === undefined || value === "") return "0.00";
    var num = Number(value);
    if (isNaN(num)) return "0.00";
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatMinutes(totalSeconds) {
    var safeSeconds = Number(totalSeconds || 0);
    var hours = Math.floor(safeSeconds / 3600);
    var minutes = Math.floor((safeSeconds % 3600) / 60);
    return hours + " س " + minutes + " د";
  }

  function formatLocalDate(date) {
    var month = String(date.getMonth() + 1);
    var day = String(date.getDate());
    return date.getFullYear() + "/" + (month.length < 2 ? "0" : "") + month +
      "/" + (day.length < 2 ? "0" : "") + day;
  }

  function pad2(value) {
    var text = String(value);
    return text.length < 2 ? "0" + text : text;
  }

  // Turn an ISO timestamp into a simple readable form: 29/10/2026 · 03:45 م
  function formatDateTime(value) {
    if (!value) return "";
    var parsed = new Date(value);
    if (isNaN(parsed.getTime())) return String(value);
    var hours = parsed.getHours();
    var hour12 = hours % 12;
    if (hour12 === 0) hour12 = 12;
    return pad2(parsed.getDate()) + "/" + pad2(parsed.getMonth() + 1) + "/" + parsed.getFullYear() +
      " · " + pad2(hour12) + ":" + pad2(parsed.getMinutes()) + " " + (hours < 12 ? "ص" : "م");
  }

  // Turn a plain YYYY-MM-DD date into DD/MM/YYYY
  function formatDateOnly(value) {
    if (!value) return "";
    var parts = String(value).split("-");
    if (parts.length !== 3) return String(value);
    return parts[2] + "/" + parts[1] + "/" + parts[0];
  }

  function currentMonthValue() {
    var date = new Date();
    var month = String(date.getMonth() + 1);
    return date.getFullYear() + "-" + (month.length < 2 ? "0" : "") + month;
  }

  function setClassFlag(element, className, enabled) {
    var classes;
    var index;
    if (!element) return;
    classes = element.className ? element.className.split(/\s+/) : [];
    index = classes.indexOf(className);
    if (enabled && index < 0) classes.push(className);
    else if (!enabled && index >= 0) classes.splice(index, 1);
    element.className = classes.join(" ");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[character];
    });
  }

  function categoryLabel(category) {
    var i;
    for (i = 0; i < allCategoriesCache.length; i += 1) {
      if (allCategoriesCache[i].slug === category) return allCategoriesCache[i].label_ar;
    }
    return category || "";
  }

  async function loadCategoriesCache() {
    allCategoriesCache = await apiCall("/api/categories");
    return allCategoriesCache;
  }

  function renderCategoryOptions(scope, selected) {
    var options = allCategoriesCache.filter(function (category) {
      return category.scope === scope && category.is_active;
    });
    return options.map(function (category) {
      return '<option value="' + escapeHtml(category.slug) + '"' +
        (String(selected) === category.slug ? " selected" : "") + '>' +
        escapeHtml(category.label_ar) + '</option>';
    }).join("");
  }

  function preserveSelectedDrinkCategory(drink) {
    var select = document.getElementById("dk-category");
    var category;
    var option;
    if (!select || !drink.category) return;
    if (Array.prototype.some.call(select.options, function (item) {
      return item.value === drink.category;
    })) {
      select.value = drink.category;
      return;
    }
    category = allCategoriesCache.filter(function (item) {
      return item.slug === drink.category && item.scope === "drink";
    })[0];
    option = document.createElement("option");
    option.value = drink.category;
    option.textContent = category
      ? category.label_ar + " (تصنيف معطّل)"
      : drink.category + " (تصنيف قديم)";
    option.disabled = true;
    select.appendChild(option);
    select.value = drink.category;
  }

  function bindInlineCategoryCreator(scope, fieldPrefix) {
    var toggle = document.getElementById(fieldPrefix + "-new-category-toggle");
    var form = document.getElementById(fieldPrefix + "-new-category");
    var input = document.getElementById(fieldPrefix + "-new-category-label");
    var submit = document.getElementById(fieldPrefix + "-new-category-submit");
    var select = document.getElementById(fieldPrefix + "-category");
    if (!toggle || !form || !input || !submit || !select) return;
    toggle.addEventListener("click", function () {
      form.hidden = !form.hidden;
      if (!form.hidden) input.focus();
    });
    submit.addEventListener("click", async function () {
      var label = input.value.replace(/^\s+|\s+$/g, "");
      var duplicate = allCategoriesCache.some(function (category) {
        return category.scope === scope &&
          category.label_ar.toLowerCase() === label.toLowerCase();
      });
      if (!label) {
        showMessage("اسم التصنيف مطلوب.");
        return;
      }
      if (duplicate) {
        showMessage("هذا التصنيف موجود بالفعل.");
        return;
      }
      try {
        var category = await apiCall("/api/categories", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({label_ar: label, scope: scope})
        });
        allCategoriesCache.push(category);
        var option = document.createElement("option");
        option.value = category.slug;
        option.textContent = category.label_ar;
        select.appendChild(option);
        select.value = category.slug;
        input.value = "";
        form.hidden = true;
        showMessage("تمت إضافة التصنيف.", true);
      } catch (error) {
        showMessage("تعذر إضافة التصنيف: " + error.message);
      }
    });
  }

  function normalizeSearchText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").toLowerCase();
  }

  function filterRows(rows, query, searchableText) {
    var normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return rows.slice(0);
    return rows.filter(function (row) {
      return normalizeSearchText(searchableText(row)).indexOf(normalizedQuery) >= 0;
    });
  }

  function bindInventorySearch(inputId, tableId, rows, searchableText, renderTable) {
    var input = document.getElementById(inputId);
    var timer = null;
    if (!input) return;
    input.addEventListener("input", function () {
      var query = input.value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        if (document.getElementById(tableId)) {
          document.getElementById(tableId).innerHTML = renderTable(
            filterRows(rows, query, searchableText), !!normalizeSearchText(query)
          );
        }
      }, 200);
    });
  }

  async function apiCall(url, options) {
    try {
      var response = await fetch(url, options || {});
      var data = await response.json();
      if (!response.ok) throw new Error(data.error || "تعذّر إتمام الطلب.");
      return data;
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  function renderImportControls(resource) {
    return '<span class="import-controls">' +
      '<input type="file" id="import-file-' + resource + '" accept=".xls,.xlsx,.xlsm,.xlsb,.csv" hidden>' +
      '<button type="button" class="button button-secondary" id="import-button-' + resource + '">استيراد من Excel</button>' +
      '<a class="button button-secondary" href="/api/admin/templates/' + resource + '">تنزيل القالب</a>' +
      '<a class="button button-secondary" href="/api/admin/export/' + resource + '">تصدير البيانات</a>' +
      '</span><div id="import-result-' + resource + '" class="import-result" aria-live="polite"></div>';
  }

  function renderImportResult(resource, result) {
    var container = document.getElementById("import-result-" + resource);
    var html = '<p>تم استيراد ' + result.imported + ' صف، وتعذر استيراد ' + result.failed + ' صف.</p>';
    var i;
    if (!container) return;
    for (i = 0; i < (result.notes || []).length; i += 1) {
      html += '<p>' + escapeHtml(result.notes[i]) + '</p>';
    }
    if (result.errors && result.errors.length) {
      html += '<ul>' + result.errors.map(function (error) {
        return '<li>الصف ' + error.row + ': ' + escapeHtml(error.reason) + '</li>';
      }).join("") + '</ul>';
    }
    container.innerHTML = html;
    container.style.display = "block";
  }

  function bindImportControls(resource) {
    var button = document.getElementById("import-button-" + resource);
    var input = document.getElementById("import-file-" + resource);
    if (!button || !input) return;
    button.addEventListener("click", function () { input.click(); });
    input.addEventListener("change", async function () {
      if (!input.files || !input.files.length) return;
      var formData = new FormData();
      formData.append("file", input.files[0]);
      button.disabled = true;
      try {
        var result = await apiCall("/api/admin/import/" + resource, {
          method: "POST",
          body: formData
        });
        var refresh = {
          books: loadBooksView,
          materials: loadMaterialsView,
          drinks: loadDrinksView,
          retail: loadRetailView
        }[resource];
        if (refresh) await refresh();
        renderImportResult(resource, result);
        showMessage("اكتمل الاستيراد: " + result.imported + " ناجح، " + result.failed + " غير ناجح.", result.failed ? "" : true);
      } catch (error) {
        showMessage("تعذر استيراد الملف: " + error.message);
      } finally {
        button.disabled = false;
        input.value = "";
      }
    });
  }

  function updateShopBrand(name) {
    var direction = /[\u0600-\u06ff]/.test(name) ? "rtl" : "ltr";
    ["admin-shop-name", "admin-eyebrow-shop-name", "cashier-shop-name", "login-shop-name"].forEach(function (id) {
      var brand = document.getElementById(id);
      if (brand) {
        brand.textContent = name;
        brand.setAttribute("dir", direction);
      }
    });
    document.title = document.title.replace(/\|.*$/, "| " + name);
  }

  function findMaterialById(id) {
      var materials = window.allMaterialsCache || [];
      var i;
      for (i = 0; i < materials.length; i += 1) {
        if (String(materials[i].id) === String(id)) return materials[i];
      }
      return null;
    }

  function disposeMaterialPickers() {
      var pickers = materialPickers.slice(0);
      var i;
      for (i = 0; i < pickers.length; i += 1) pickers[i].destroy();
      materialPickers = [];
      materialNamePicker = null;
    }

  function createMaterialPicker(containerEl, options) {
      options = options || {};
      var wrapper = document.createElement("div");
      var input = document.createElement("input");
      var dropdown = document.createElement("div");
      var hint = document.createElement("small");
      var selectedMaterialId = null;
      var activeIndex = -1;
      var suggestions = [];
      var destroyed = false;
      var allowFreeText = options.allowFreeText === true;

      wrapper.className = "mat-picker";
      input.type = "text";
      input.className = "mat-picker-input";
      input.placeholder = "اكتب اسم المادة...";
      input.required = options.required === true;
      input.setAttribute("autocomplete", "off");
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-expanded", "false");
      if (options.inputId) input.id = options.inputId;
      dropdown.className = "mat-picker-dropdown";
      dropdown.setAttribute("role", "listbox");
      dropdown.style.display = "none";
      hint.className = "mat-picker-hint";
      hint.style.display = "none";
      wrapper.appendChild(input);
      wrapper.appendChild(dropdown);
      wrapper.appendChild(hint);
      containerEl.appendChild(wrapper);

      function updateHint(text, state) {
        hint.textContent = text || "";
        hint.className = "mat-picker-hint" + (state ? " " + state : "");
        hint.style.display = text ? "block" : "none";
        setClassFlag(input, "mat-picker-invalid", state === "invalid");
      }

      function closeDropdown() {
        dropdown.style.display = "none";
        input.setAttribute("aria-expanded", "false");
        activeIndex = -1;
      }

      function selectMaterial(material, notify) {
        var previousId = selectedMaterialId;
        selectedMaterialId = material ? material.id : null;
        input.value = material ? material.name : input.value;
        closeDropdown();
        updateHint("", "");
        if (typeof options.onChange === "function") {
          options.onChange(material || null, input.value);
        }
        if (material && notify !== false && String(previousId) !== String(material.id) &&
            typeof options.onSelect === "function") {
          options.onSelect(material);
        }
      }

      function exactMatch(value) {
        var normalized = String(value || "").replace(/^\s+|\s+$/g, "").toLowerCase();
        var materials = window.allMaterialsCache || [];
        var i;
        for (i = 0; i < materials.length; i += 1) {
          if (String(materials[i].name || "").replace(/^\s+|\s+$/g, "").toLowerCase() === normalized) {
            return materials[i];
          }
        }
        return null;
      }

      function renderSuggestions() {
        var token = input.value.replace(/^\s+|\s+$/g, "").toLowerCase();
        var materials = window.allMaterialsCache || [];
        var starts = [];
        var contains = [];
        var i;
        var name;
        var material;
        var row;
        var cost;
        if (token.length < 2) {
          closeDropdown();
          return;
        }
        for (i = 0; i < materials.length; i += 1) {
          material = materials[i];
          name = String(material.name || "").toLowerCase();
          if (name.indexOf(token) === 0) starts.push(material);
          else if (name.indexOf(token) >= 0) contains.push(material);
        }
        suggestions = starts.concat(contains);
        dropdown.innerHTML = "";
        if (!suggestions.length) {
          closeDropdown();
          return;
        }
        for (i = 0; i < suggestions.length; i += 1) {
          material = suggestions[i];
          row = document.createElement("button");
          row.type = "button";
          row.className = "mat-picker-option";
          row.setAttribute("role", "option");
          cost = Number(material.cost_per_unit);
          row.textContent = material.name + " — " + (material.unit_label || material.unit) + " — " +
            (isNaN(cost) ? "0.00" : formatMoney(cost)) + " — " +
            formatMoney(material.current_stock);
          row.addEventListener("mousedown", function (event) {
            event.preventDefault();
          });
          row.addEventListener("click", (function (selected) {
            return function () { selectMaterial(selected, true); };
          }(material)));
          dropdown.appendChild(row);
        }
        dropdown.style.display = "block";
        input.setAttribute("aria-expanded", "true");
        activeIndex = -1;
      }

      function onInput() {
        var exact;
        selectedMaterialId = null;
        exact = exactMatch(input.value);
        if (exact) {
          selectMaterial(exact, true);
        } else {
          closeDropdown();
          if (!allowFreeText && input.value.replace(/^\s+|\s+$/g, "")) {
            updateHint("المادة غير مسجلة — أضفها أولاً من صفحة المواد.", "invalid");
          } else {
            updateHint("", "");
          }
          if (typeof options.onChange === "function") {
            options.onChange(null, input.value);
          }
          renderSuggestions();
        }
      }

      function onKeyDown(event) {
        var rows = dropdown.querySelectorAll(".mat-picker-option");
        var key = event.key || event.keyCode;
        if ((key === "ArrowDown" || key === 40) && rows.length) {
          event.preventDefault();
          activeIndex = (activeIndex + 1) % rows.length;
        } else if ((key === "ArrowUp" || key === 38) && rows.length) {
          event.preventDefault();
          activeIndex = activeIndex <= 0 ? rows.length - 1 : activeIndex - 1;
        } else if ((key === "Enter" || key === 13) && activeIndex >= 0 && suggestions[activeIndex]) {
          event.preventDefault();
          selectMaterial(suggestions[activeIndex], true);
          return;
        } else if (key === "Escape" || key === 27) {
          closeDropdown();
          return;
        } else {
          return;
        }
        var i;
        for (i = 0; i < rows.length; i += 1) {
          setClassFlag(rows[i], "active", i === activeIndex);
        }
      }

      function onDocumentClick(event) {
        if (!wrapper.contains(event.target)) closeDropdown();
      }

      input.addEventListener("input", onInput);
      input.addEventListener("keydown", onKeyDown);
      document.addEventListener("click", onDocumentClick);

      var picker = {
        input: input,
        getSelected: function () {
          return selectedMaterialId === null ? null : findMaterialById(selectedMaterialId);
        },
        getSelectedMaterial: function () {
          return picker.getSelected();
        },
        isInvalid: function () {
          return !allowFreeText && !!input.value.replace(/^\s+|\s+$/g, "") &&
            selectedMaterialId === null;
        },
        setSelected: function (id) {
          var material = findMaterialById(id);
          if (!material) {
            selectedMaterialId = null;
            input.value = "";
            updateHint("", "");
            return false;
          }
          selectMaterial(material, true);
          return true;
        },
        reset: function () {
          selectedMaterialId = null;
          input.value = "";
          closeDropdown();
          updateHint("", "");
          if (typeof options.onChange === "function") options.onChange(null, "");
        },
        showError: function (text) {
          updateHint(text, text ? "invalid" : "");
        },
        destroy: function () {
          var pickerIndex;
          if (destroyed) return;
          destroyed = true;
          input.removeEventListener("input", onInput);
          input.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("click", onDocumentClick);
          closeDropdown();
          pickerIndex = materialPickers.indexOf(picker);
          if (pickerIndex >= 0) materialPickers.splice(pickerIndex, 1);
        }
      };
      materialPickers.push(picker);
      if (options.initialValueId !== undefined && options.initialValueId !== null) {
        picker.setSelected(options.initialValueId);
      }
      return picker;
  }

  function showMessage(text, isSuccess) {
    if(!messageEl) return;
    messageEl.textContent = text || "";
    messageEl.className = "form-message" + (isSuccess ? " success" : "");
    setTimeout(() => { 
        if(messageEl && messageEl.textContent === text) {
            messageEl.textContent = ""; 
        }
    }, 5000);
  }

  // ==========================================
  // NAVIGATION LOGIC
  // ==========================================
  function switchView(view) {
    if (view === "reports") view = "projects";
    var viewTask = null;
    currentView = view;
    
    // Hide all views
    document.querySelectorAll(".admin-view").forEach(section => {
      section.hidden = section.id !== "view-" + view;
    });
    
    // Update active nav button
    document.querySelectorAll(".nav-item[data-view]").forEach(button => {
      button.classList.toggle("active", button.dataset.view === view);
    });
    
    // Update Title
    var titles = {dashboard: "لوحة المعلومات", books: "الكتب", drinks: "المشروبات", materials: "المواد الخام", retail: "منتجات جاهزة", expenses: "المصروفات", employees: "الموظفين", projects: "تقرير المشاريع", attendance: "الحضور والورديات", payroll: "الرواتب", categories: "الأقسام والتصنيفات", purge: "تصفية/تفريغ النظام", settings: "الإعدادات"};
    document.getElementById("page-title").textContent = titles[view] || "الإدارة";
    document.getElementById("admin-current-section").textContent = titles[view] || "الإدارة";
    
    // Close mobile sidebar
    document.getElementById("sidebar")?.classList.remove("open");
    document.getElementById("nav-shade")?.classList.remove("open");
    
    showMessage("");
    
    // Load Content
    if (view === "dashboard") viewTask = loadDashboard();
    else if (view === "books") viewTask = loadBooksView();
    else if (view === "drinks") viewTask = loadDrinksView();
    else if (view === "materials") viewTask = loadMaterialsView();
    else if (view === "retail") viewTask = loadRetailView();
    else if (view === "expenses") viewTask = renderExpensesView();
    else if (view === "employees") viewTask = renderEmployeesView();
    else if (view === "projects") viewTask = renderProjectsView();
    else if (view === "attendance") viewTask = renderAttendanceView();
    else if (view === "payroll") viewTask = renderPayrollView();
    else if (view === "categories") viewTask = loadCategoriesView();
    else if (view === "purge") viewTask = renderPurgeView();
    else if (view === "reports") viewTask = renderReports();
    else if (view === "settings") viewTask = renderSettings();
    return viewTask;
  }

  // ==========================================
  // SYSTEM PURGE (Batch 3a) — admin-only
  // ==========================================
  function closePurgeModal() {
    var modal = document.getElementById("purge-modal");
    if (modal) modal.remove();
  }

  function openPurgeConfirmModal(options) {
    closePurgeModal();
    var overlay = document.createElement("div");
    overlay.id = "purge-modal";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML =
      '<div class="modal-content purge-modal-content">' +
      '<div class="modal-header"><h2 class="modal-title">' + escapeHtml(options.title) + '</h2>' +
      '<button type="button" class="close-modal-btn" data-close aria-label="إغلاق">×</button></div>' +
      '<p class="purge-modal-message">' + escapeHtml(options.message) + '</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="button button-secondary" data-close>إلغاء</button>' +
      '<button type="button" class="button button-danger" id="purge-confirm-button">' +
      escapeHtml(options.confirmLabel) + '</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    var confirmButton = document.getElementById("purge-confirm-button");
    overlay.querySelectorAll("[data-close]").forEach(function (element) {
      element.addEventListener("click", closePurgeModal);
    });
    confirmButton.addEventListener("click", async function () {
      confirmButton.disabled = true;
      try {
        var result = await apiCall("/api/admin/purge/" + options.scope, {
          method: "DELETE",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({confirmed: true})
        });
        closePurgeModal();
        showMessage(result.message, true);
      } catch (error) {
        if (String(error.message || "").indexOf("تم إيقاف حساب الموظف") >= 0) {
          showMessage("تم إيقاف حساب الموظف وحفظ سجلاته.", true);
          await renderEmployeesView();
        } else {
          showMessage(error.message);
        }
        confirmButton.disabled = false;
      }
    });
    confirmButton.focus();
  }

  function openPurgeChoiceModal() {
    closePurgeModal();
    var overlay = document.createElement("div");
    overlay.id = "purge-modal";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML =
      '<div class="modal-content purge-modal-content">' +
      '<div class="modal-header"><h2 class="modal-title">مسح السيستم</h2>' +
      '<button type="button" class="close-modal-btn" data-close aria-label="إغلاق">×</button></div>' +
      '<p class="purge-modal-message">تمسح قسم معين ولا كل الداتا؟</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="button button-secondary" id="purge-choice-section">قسم معين</button>' +
      '<button type="button" class="button button-danger" id="purge-choice-all">كل الداتا</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    overlay.querySelectorAll("[data-close]").forEach(function (element) {
      element.addEventListener("click", closePurgeModal);
    });
    document.getElementById("purge-choice-section").addEventListener("click", function () {
      closePurgeModal();
      showMessage("اختر القسم الذي تريد تفريغه من البطاقات أدناه.", true);
    });
    document.getElementById("purge-choice-all").addEventListener("click", function () {
      openPurgeConfirmModal({
        title: "مسح كل الداتا",
        message: "سيتم حذف كل بيانات النظام نهائيًا (يبقى حساب المدير والإعدادات الأساسية). هل تريد المتابعة؟",
        confirmLabel: "مسح السيستم",
        scope: "all"
      });
    });
  }

  async function renderPurgeView() {
    var section = document.getElementById("view-purge");
    if (!section) return;
    if (document.body.dataset.isAdmin !== "true") {
      section.innerHTML = '<p class="empty-table">شاشة التفريغ متاحة للمدير فقط.</p>';
      return;
    }
    var catalog;
    try {
      catalog = await apiCall("/api/admin/purge/scopes");
    } catch (error) {
      section.innerHTML = '<p class="empty-table">' + escapeHtml(error.message) + '</p>';
      return;
    }
    window.purgeCatalog = catalog;
    var cards = catalog.scopes.map(function (scope) {
      return '<article class="purge-card">' +
        '<h3>' + escapeHtml(scope.label) + '</h3>' +
        '<button type="button" class="button button-danger" data-purge-scope="' +
        escapeHtml(scope.key) + '">تفريغ القسم</button>' +
        '</article>';
    }).join("");
    section.innerHTML =
      '<article class="panel purge-panel">' +
      '<div class="panel-heading"><h2>تصفية/تفريغ النظام</h2></div>' +
      '<p class="purge-warning">تحذير: تفريغ البيانات نهائي ولا يمكن التراجع عنه. خُذ نسخة احتياطية من قاعدة البيانات قبل المتابعة.</p>' +
      '<div class="purge-global">' +
      '<div><h3>مسح السيستم</h3>' +
      '<p class="muted small">حذف كل بيانات النظام (المخزون والمبيعات والمصروفات والموظفين والتصنيفات)، مع الإبقاء على حساب المدير والإعدادات الأساسية.</p></div>' +
      '<button type="button" class="button button-danger" id="purge-global-button">مسح السيستم</button>' +
      '</div>' +
      '<div class="purge-grid">' + cards + '</div>' +
      '</article>';
    document.getElementById("purge-global-button").addEventListener("click", openPurgeChoiceModal);
    section.querySelectorAll("[data-purge-scope]").forEach(function (button) {
      button.addEventListener("click", function () {
        var key = button.getAttribute("data-purge-scope");
        var scope = (window.purgeCatalog.scopes || []).filter(function (item) {
          return item.key === key;
        })[0];
        if (!scope) return;
        var message = "سيتم حذف كل بيانات قسم «" + scope.label + "» نهائيًا. هل تريد المتابعة؟";
        if (key === "orders") {
          message += " تحذير: سيتم مسح المبيعات وكل التقارير والسجل التاريخي نهائيًا.";
        }
        openPurgeConfirmModal({
          title: "تفريغ قسم " + scope.label,
          message: message,
          confirmLabel: "تفريغ القسم",
          scope: key
        });
      });
    });
  }

  // ==========================================
  // EXPENSES VIEW (Batch 4) — admin + expense managers
  // ==========================================
  function localTodayIso() {
    var now = new Date();
    return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
  }

  async function renderExpensesView() {
    var section = document.getElementById("view-expenses");
    if (!section) return;
    section.innerHTML =
      '<article class="panel">' +
      '<div class="panel-heading"><h2>تسجيل مصروف جديد</h2></div>' +
      '<div class="admin-form expense-form">' +
      '<div class="field"><label for="exp-date">التاريخ</label><input id="exp-date" type="date" value="' + localTodayIso() + '"></div>' +
      '<div class="field"><label for="exp-category">البند</label><input id="exp-category" list="expense-category-list" type="text" placeholder="اختر بندًا أو اكتب بندًا جديدًا" autocomplete="off"><datalist id="expense-category-list"></datalist></div>' +
      '<div class="field"><label for="exp-amount">المبلغ</label><input id="exp-amount" type="number" min="0" step="0.01"></div>' +
      '<div class="field field-wide"><label for="exp-note">ملاحظة</label><input id="exp-note" type="text" placeholder="تفاصيل إضافية (اختياري)"></div>' +
      '<div class="field field-wide"><label>إضافة البند إلى المخزون</label>' +
      '<div id="exp-suggestions" class="stock-suggestions" hidden></div>' +
      '<div id="exp-stock-selected" class="stock-selected" hidden></div>' +
      '<div class="stock-selected-fields">' +
      '<label for="exp-new-kind">نوع الصنف عند الكتابة أول مرة</label>' +
      '<select id="exp-new-kind"><option value="material">مادة خام</option><option value="retail">منتج جاهز</option><option value="book">كتاب</option><option value="drink">مشروب</option></select>' +
      '<label for="exp-new-unit">الوحدة</label>' +
      '<select id="exp-new-unit"><option value="kg">كجم</option><option value="g">جرام</option><option value="L">لتر</option><option value="ml">مل</option><option value="pcs">قطعة</option></select>' +
      '</div>' +
      '<p class="muted small">اكتب اسم البند؛ يقترح النظام صنفًا من الخامات أو المنتجات الجاهزة أو المشروبات أو الكتب، وتُضاف الكمية تلقائيًا بعد الحفظ.</p>' +
      '</div>' +
      '<div class="field form-actions"><button type="button" class="button button-primary" id="exp-save-button">إضافة المصروف</button></div>' +
      '</div></article>' +
      '<article class="panel closing-panel">' +
      '<div class="panel-heading"><h2>تقفيل اليوم</h2>' +
      '<div class="inventory-heading-actions">' +
      '<button type="button" class="button button-secondary" id="closing-refresh-button">تحديث</button>' +
      '</div></div>' +
      '<div id="closing-body"><p class="empty-table">جارٍ تحميل بيانات اليوم...</p></div>' +
      '</article>' +
      '<article class="panel">' +
      '<div class="panel-heading"><h2>تقرير المصروفات</h2>' +
      '<div class="inventory-heading-actions">' +
      '<input id="exp-month" type="month" value="' + currentMonthValue() + '" aria-label="الشهر">' +
      '<button type="button" class="button button-secondary" id="exp-refresh-button">تحديث</button>' +
      '</div></div>' +
      '<div id="exp-metrics" class="metric-grid"></div>' +
      '<div id="exp-report-body" class="table-wrap"><p class="empty-table">جارٍ تحميل المصروفات...</p></div>' +
      '</article>';
    document.getElementById("exp-save-button").addEventListener("click", saveExpense);
    document.getElementById("exp-refresh-button").addEventListener("click", loadExpensesData);
    var monthInput = document.getElementById("exp-month");
    if (monthInput) monthInput.addEventListener("change", loadExpensesData);
    bindExpenseStockSuggestions();
    apiCall("/api/admin/expense-categories").then(function (categories) {
      var list = document.getElementById("expense-category-list");
      if (!list) return;
      list.innerHTML = categories.map(function (category) {
        return "<option value=\"" + escapeHtml(category.name) + "\"></option>";
      }).join("");
    }).catch(function (error) {
      showMessage("تعذر تحميل بنود المصروفات: " + error.message);
    });
    var closingRefresh = document.getElementById("closing-refresh-button");
    if (closingRefresh) closingRefresh.addEventListener("click", loadClosingState);
    await Promise.all([loadExpensesData(), loadClosingState()]);
  }

  // ==========================================
  // EXPENSE → STOCK SUGGESTIONS
  // ==========================================
  var expenseStockItem = null;
  var expenseSuggestionTimer = null;

  function renderExpenseStockSelection() {
    var target = document.getElementById("exp-stock-selected");
    if (!target) return;
    if (!expenseStockItem) {
      target.hidden = true;
      target.innerHTML = "";
      return;
    }
    target.hidden = false;
    target.innerHTML =
      '<div class="stock-selected-row">' +
      '<span class="stock-kind-badge">' + escapeHtml(expenseStockItem.kind_label) + '</span>' +
      '<strong>' + escapeHtml(expenseStockItem.name) + '</strong>' +
      '<span class="muted">المخزون الحالي ' + (expenseStockItem.stock === null ? "غير متتبع" : formatMoney(expenseStockItem.stock) + " " + escapeHtml(expenseStockItem.unit || "")) + '</span>' +
      '</div>' +
      '<div class="stock-selected-fields">' +
      '<label for="exp-stock-qty">الكمية المضافة</label>' +
      '<input id="exp-stock-qty" type="number" min="0" step="' + (expenseStockItem.kind === "material" ? "0.001" : "1") + '" value="1">' +
      '<label for="exp-stock-cost">تكلفة الوحدة</label>' +
      '<input id="exp-stock-cost" type="number" min="0" step="0.01" value="' + formatMoney(expenseStockItem.unit_cost) + '">' +
      '<button type="button" class="button button-secondary" id="exp-stock-clear">إلغاء الربط</button>' +
      '</div>';
    var clearButton = document.getElementById("exp-stock-clear");
    if (clearButton) {
      clearButton.addEventListener("click", function () {
        expenseStockItem = null;
        renderExpenseStockSelection();
      });
    }
  }

  function showExpenseSuggestions(rows) {
    var target = document.getElementById("exp-suggestions");
    if (!target) return;
    if (!rows.length) {
      target.hidden = true;
      target.innerHTML = "";
      return;
    }
    target.hidden = false;
    target.innerHTML = rows.map(function (row) {
      return '<button type="button" class="stock-suggestion" data-stock-index="' + Number(row._index) + '">' +
        '<span class="stock-kind-badge">' + escapeHtml(row.kind_label) + '</span>' +
        escapeHtml(row.name) +
        '<small>' + escapeHtml(row.unit || "") + ' · مخزون ' + (row.stock === null ? "—" : formatMoney(row.stock)) + '</small>' +
        '</button>';
    }).join("");
  }

  function bindExpenseStockSuggestions() {
    var categoryInput = document.getElementById("exp-category");
    var container = document.getElementById("exp-suggestions");
    if (!categoryInput || !container) return;
    expenseStockItem = null;
    renderExpenseStockSelection();
    categoryInput.addEventListener("input", function () {
      var query = categoryInput.value.trim();
      if (expenseSuggestionTimer) clearTimeout(expenseSuggestionTimer);
      if (query.length < 2) {
        showExpenseSuggestions([]);
        return;
      }
      expenseSuggestionTimer = setTimeout(function () {
        apiCall("/api/stock-suggestions?q=" + encodeURIComponent(query)).then(function (rows) {
          rows.forEach(function (row, index) { row._index = index; });
          window.expenseSuggestionRows = rows;
          showExpenseSuggestions(rows.slice(0, 8));
        }).catch(function (error) {
          showExpenseSuggestions([]);
          showMessage("تعذر تحميل اقتراحات المخزون: " + error.message);
        });
      }, 250);
    });
    container.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("[data-stock-index]") : null;
      if (!button) return;
      var rows = window.expenseSuggestionRows || [];
      var picked = rows[Number(button.getAttribute("data-stock-index"))];
      if (!picked) return;
      expenseStockItem = picked;
      showExpenseSuggestions([]);
      renderExpenseStockSelection();
    });
  }

  function expenseStockPayload() {
    var qtyInput = document.getElementById("exp-stock-qty");
    var costInput = document.getElementById("exp-stock-cost");
    if (!expenseStockItem || !qtyInput) return null;
    if (!expenseStockItem.affects_stock) return null;
    var quantity = Number(qtyInput.value || 0);
    if (!(quantity > 0)) return null;
    return {
      kind: expenseStockItem.kind,
      id: expenseStockItem.id,
      name: expenseStockItem.name,
      quantity: quantity,
      unit_cost: costInput && costInput.value !== "" ? Number(costInput.value) : expenseStockItem.unit_cost
    };
  }

  // ==========================================
  // DAY CLOSING
  // ==========================================
  function closingMetricCard(label, value, tone) {
    return '<div class="metric-card"><span>' + label + '</span><strong dir="ltr"' +
      (tone ? ' class="' + tone + '"' : "") + ">" + value + "</strong></div>";
  }

  async function loadClosingState() {
    var body = document.getElementById("closing-body");
    if (!body) return;
    body.innerHTML = '<p class="empty-table">جارٍ تحميل بيانات اليوم...</p>';
    var state;
    try {
      state = await apiCall("/api/closing/state");
    } catch (error) {
      body.innerHTML = '<p class="empty-table">تعذر تحميل بيانات التقفيل: ' + escapeHtml(error.message) + "</p>";
      return;
    }
    var day = state.day_summary || {};
    var sealed = state.day_closing;
    var reports = (state.reports || []).slice(0, 20);
    body.innerHTML =
      '<div class="metric-grid">' +
      closingMetricCard("مبيعات اليوم", formatMoney(day.sales)) +
      closingMetricCard("عدد الفواتير", Number(day.orders_count || 0)) +
      closingMetricCard("مصروفات اليوم", formatMoney(day.expenses)) +
      closingMetricCard("رصيد الدرج المتوقع", formatMoney(day.drawer_balance)) +
      '</div>' +
      (sealed
        ? '<p class="closing-status closed">تم تقفيل يوم ' + escapeHtml(formatDateOnly(state.today)) + " · المعدود " +
            formatMoney(sealed.counted_cash) + " · الفرق " + formatMoney(sealed.closing_variance) +
            " بواسطة " + escapeHtml(sealed.closed_by || "") + ".</p>"
        : '<p class="closing-status">اليوم ما زال مفتوحًا. التقفيل يخزن تقرير اليوم ويبدأ يومًا جديدًا من الصفر.</p>') +
      (sealed ? "" :
        '<div class="admin-form">' +
        '<div class="field"><label for="closing-counted">رصيد الدرج المعدود</label>' +
        '<input id="closing-counted" type="number" min="0" step="0.01" value="' + Number(day.drawer_balance || 0) + '"></div>' +
        '<div class="field"><label for="closing-note">ملاحظة (اختياري)</label><input id="closing-note" type="text" maxlength="300"></div>' +
        '<div class="field form-actions"><button type="button" class="button button-danger" id="closing-run-button">' +
        (sealed ? "تقفيل اليوم" : "تقفيل اليوم الآن") + '</button></div>' +
        '</div>') +
      '<h3>التقارير المقفلة</h3>' +
      '<div class="table-wrap"><table><thead><tr><th>الفترة</th><th>النوع</th><th>المتوقع</th><th>المعدود</th><th>الفرق</th><th>بواسطة</th><th>إجراء</th></tr></thead><tbody>' +
      (reports.map(function (report) {
        return "<tr><td>" + escapeHtml(report.period_type === "month" ? report.period_key : formatDateOnly(report.period_key)) +
          '</td><td>' + (report.period_type === "month" ? (report.auto_generated ? "شهر (تلقائي)" : "شهر") : "يوم") +
          '</td><td dir="ltr">' + formatMoney(report.expected_cash) +
          '</td><td dir="ltr">' + formatMoney(report.counted_cash) +
          '</td><td dir="ltr">' + formatMoney(report.closing_variance) +
          '</td><td>' + escapeHtml(report.closed_by || "—") + "</td>" +
          "<td>" + (report.period_type === "day"
            ? '<button type="button" class="button button-secondary" data-reopen-day="' + escapeHtml(report.period_key) + '">إعادة فتح</button>'
            : "—") + "</td></tr>";
      }).join("") || '<tr><td colspan="7">لا توجد تقارير مقفلة بعد.</td></tr>') +
      "</tbody></table></div>" +
      ((state.pending_months || []).length
        ? '<p class="muted small">أشهر بانتظار التقفيل التلقائي: ' + escapeHtml(state.pending_months.join("، ")) + "</p>"
        : "");
    var runButton = document.getElementById("closing-run-button");
    if (runButton) runButton.addEventListener("click", runDayClose);
    var table = body.querySelector("table");
    if (table) {
      table.addEventListener("click", function (event) {
        var button = event.target.closest ? event.target.closest("[data-reopen-day]") : null;
        if (button) reopenClosedDay(button.getAttribute("data-reopen-day"));
      });
    }
  }

  async function runDayClose() {
    var countedInput = document.getElementById("closing-counted");
    var noteInput = document.getElementById("closing-note");
    var counted = countedInput ? countedInput.value : "";
    if (counted === "" || Number(counted) < 0) {
      showMessage("أدخل رصيد الدرج المعدود قبل التقفيل.");
      return;
    }
    if (!window.confirm("تقفيل اليوم " + localTodayIso() + "؟ سيتم تخزين تقرير اليوم وإغلاق الوردية وفتح يوم جديد.")) return;
    var button = document.getElementById("closing-run-button");
    if (button) button.disabled = true;
    try {
      var result = await apiCall("/api/day-close", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({date: localTodayIso(), counted_cash: counted, note: noteInput ? noteInput.value.trim() : ""})
      });
      showMessage("تم تقفيل اليوم · الفرق " + formatMoney(result.closing_variance) + " · بدأ يوم " + (result.next_day || ""), true);
      await Promise.all([loadClosingState(), loadExpensesData()]);
    } catch (error) {
      showMessage(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function reopenClosedDay(day) {
    if (!window.confirm("إعادة فتح يوم " + day + "؟ سيُحذف التقرير المقفل ويمكن التعديل على اليوم مجددًا.")) return;
    try {
      await apiCall("/api/closing/reopen", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({period: "day", date: day})
      });
      showMessage("تم إعادة فتح اليوم.", true);
      await loadClosingState();
    } catch (error) {
      showMessage(error.message);
    }
  }

  async function saveExpense() {
    var dateInput = document.getElementById("exp-date");
    var categoryInput = document.getElementById("exp-category");
    var amountInput = document.getElementById("exp-amount");
    var noteInput = document.getElementById("exp-note");
    var payload = {
      date: dateInput ? dateInput.value : "",
      category: categoryInput ? categoryInput.value.trim() : "",
      amount: amountInput ? amountInput.value : "",
      note: noteInput ? noteInput.value.trim() : ""
    };
    if (!payload.date || !payload.category || payload.amount === "") {
      showMessage("التاريخ والبند والمبلغ حقول مطلوبة.");
      return;
    }
    var stockItem = expenseStockPayload();
    if (stockItem) payload.stock_item = stockItem;
    else if (categoryInput.value.trim()) {
      var typedName = categoryInput.value.trim();
      var likelyExisting = (window.expenseSuggestionRows || []).find(function (row) {
        return row.name && row.name.toLowerCase() === typedName.toLowerCase();
      });
      if (!likelyExisting) {
        var newKind = document.getElementById("exp-new-kind");
        var newUnit = document.getElementById("exp-new-unit");
        payload.new_stock_item = {
          kind: newKind ? newKind.value : "material",
          name: typedName,
          quantity: 1,
          unit_cost: Number(amountInput.value || 0),
          unit: newUnit ? newUnit.value : "pcs",
          purchase_unit: newUnit ? newUnit.value : "pcs",
          usage_unit: newUnit ? newUnit.value : "pcs",
          reorder_level: 5
        };
      }
    }
    var saveButton = document.getElementById("exp-save-button");
    if (saveButton) saveButton.disabled = true;
    try {
      await apiCall("/api/admin/expenses", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      await apiCall("/api/admin/expense-categories", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: categoryInput.value.trim()})
      });
      showMessage(stockItem
        ? "تم تسجيل المصروف وزيادة مخزون " + stockItem.name + "."
        : "تم تسجيل المصروف وربطه بصندوق الدرج والسجلات.", true);
      if (categoryInput) categoryInput.value = "";
      if (amountInput) amountInput.value = "";
      if (noteInput) noteInput.value = "";
      expenseStockItem = null;
      renderExpenseStockSelection();
      await Promise.all([loadExpensesData(), loadClosingState()]);
    } catch (error) {
      showMessage(error.message);
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  }

  async function deleteExpense(expenseId) {
    if (!window.confirm("تأكيد حذف المصروف رقم " + expenseId + "؟ سيُحذف قيده من الدرج أيضاً.")) return;
    try {
      await apiCall("/api/admin/expenses/" + expenseId, {method: "DELETE"});
      showMessage("تم حذف المصروف.", true);
      await Promise.all([loadExpensesData(), loadClosingState()]);
    } catch (error) {
      showMessage(error.message);
    }
  }
  window.deleteExpense = deleteExpense;

  async function loadExpensesData() {
    var body = document.getElementById("exp-report-body");
    var metrics = document.getElementById("exp-metrics");
    var monthInput = document.getElementById("exp-month");
    var rows;
    var today;
    var monthPrefix;
    var todayTotal = 0;
    var monthTotal = 0;
    var grandTotal = 0;
    var perDay = {};
    var days;
    if (!body) return;
    try {
      rows = await apiCall("/api/admin/expenses");
    } catch (error) {
      body.innerHTML = '<p class="empty-table">تعذر تحميل المصروفات: ' + escapeHtml(error.message) + '</p>';
      if (metrics) metrics.innerHTML = "";
      return;
    }
    today = localTodayIso();
    monthPrefix = (monthInput && monthInput.value) || currentMonthValue();
    rows.forEach(function (row) {
      var amount = Number(row.amount) || 0;
      var day = String(row.date || "");
      grandTotal += amount;
      if (day === today) todayTotal += amount;
      if (day.indexOf(monthPrefix) === 0) {
        monthTotal += amount;
        perDay[day] = (perDay[day] || 0) + amount;
      }
    });
    if (metrics) {
      metrics.innerHTML =
        '<div class="metric-card"><span>مصروفات اليوم</span><strong dir="ltr">' + formatMoney(todayTotal) + '</strong></div>' +
        '<div class="metric-card"><span>مصروفات الشهر المختار</span><strong dir="ltr">' + formatMoney(monthTotal) + '</strong></div>' +
        '<div class="metric-card"><span>إجمالي المصروفات المسجلة</span><strong dir="ltr">' + formatMoney(grandTotal) + '</strong></div>';
    }
    if (!rows.length) {
      body.innerHTML = '<p class="empty-table">لا توجد مصروفات مسجلة.</p>';
      return;
    }
    days = Object.keys(perDay).sort().reverse();
    body.innerHTML =
      '<h3>إجمالي المصروفات اليومية — ' + escapeHtml(monthPrefix) + '</h3>' +
      '<table><thead><tr><th>اليوم</th><th>الإجمالي</th></tr></thead><tbody>' +
      (days.map(function (day) {
        return '<tr><td>' + escapeHtml(formatDateOnly(day)) + '</td><td dir="ltr">' + formatMoney(perDay[day]) + '</td></tr>';
      }).join("") || '<tr><td colspan="2">لا توجد مصروفات في هذا الشهر.</td></tr>') +
      '</tbody></table>' +
      '<h3>سجل المصروفات</h3>' +
      '<table><thead><tr><th>التاريخ</th><th>البند</th><th>المبلغ</th><th>ملاحظة</th><th>الموظف</th><th>إجراء</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr><td>' + escapeHtml(formatDateOnly(row.date)) + '</td><td>' + escapeHtml(row.category) +
          '</td><td dir="ltr">' + formatMoney(row.amount) + '</td><td>' + escapeHtml(row.note || "") +
          '</td><td>' + escapeHtml(row.employee_name || "—") +
          '</td><td><button type="button" class="button button-danger" onclick="deleteExpense(' + Number(row.id) + ')">حذف</button></td></tr>';
      }).join("") +
      '</tbody></table>';
  }

  // ==========================================
  // DASHBOARD
  // ==========================================
  async function loadDashboard() {
    try {
      var data = await apiCall("/api/admin/dashboard");
      
      document.getElementById("metric-sales").textContent = formatMoney(data.today_sales);
      document.getElementById("metric-profit").textContent = formatMoney(data.today_profit);
      document.getElementById("metric-orders").textContent = Number(data.today_orders_count || 0).toLocaleString("en-US");
      document.getElementById("metric-last-sale").textContent = data.last_sale ?
        "#" + data.last_sale.id + " · " + formatDateTime(data.last_sale.timestamp) :
        "لا توجد مبيعات اليوم";
      document.getElementById("metric-last-sale-amount").textContent = data.last_sale ?
        formatMoney(data.last_sale.total_amount) : "";
      document.getElementById("metric-alerts").textContent = data.low_stock.length;
      
      var target = document.getElementById("low-stock-list");
      if (!data.low_stock.length) {
        target.innerHTML = '<p class="empty-table">لا توجد مواد منخفضة المخزون.</p>';
      } else {
        target.innerHTML = '<table><thead><tr><th>الصنف</th><th>المخزون</th><th>الوحدة</th></tr></thead><tbody>' +
          data.low_stock.map(item => 
            `<tr><td>${escapeHtml(item.name)}</td><td dir="ltr">${item.current_stock}</td><td>${escapeHtml(item.unit)}</td></tr>`
          ).join("") + "</tbody></table>";
      }
    } catch (error) { showMessage(error.message); }
  }

  async function renderEmployeesView() {
    var section = document.getElementById("view-employees");
    try {
      var employees = await apiCall("/api/admin/employees");
      employeesCache = employees;
      section.innerHTML = `
        <article class="panel">
          <div class="panel-heading"><h2>إدارة الموظفين</h2></div>
          <div class="admin-form employee-form">
            <input id="emp-edit-id" type="hidden" value="">
            <div class="field"><label>اسم المستخدم</label><input id="emp-username" type="text" placeholder="مثال: cashier3"></div>
            <div class="field"><label>كلمة المرور</label><input id="emp-password" type="password" placeholder="مطلوبة عند الإضافة، واتركها فارغة دون تغيير"></div>
            <div class="field"><label>الراتب الشهري</label><input id="emp-salary" type="number" min="0" step="0.01" value="3000"></div>
            <fieldset class="employee-permissions">
              <legend>الصلاحيات</legend>
              <div class="employee-permission-grid">
                <label><input id="emp-can-sell" type="checkbox" checked> يسمح ببيع السلع</label>
                <label><input id="emp-expenses" type="checkbox"> يسمح بإدارة المصروفات</label>
                <label><input id="emp-purchases" type="checkbox"> يسمح بإدارة المشتريات</label>
                <label><input id="emp-inventory" type="checkbox"> يسمح بإدارة الكتب والمشروبات والمواد الخام والمنتجات</label>
                <label><input id="emp-join-existing-shift" type="checkbox"> يسمح بفتح وردية بالتزامن مع موظف آخر (درج نقدي مشترك)</label>
              </div>
            </fieldset>
            <div class="field form-actions"><button id="emp-save-button" class="button button-primary" onclick="saveEmployee()">حفظ الموظف</button><button class="button button-secondary" onclick="resetEmployeeForm()">مسح الحقول</button></div>
          </div>
        </article>
        <article class="panel">
          <div class="panel-heading"><h2>قائمة الموظفين</h2></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>اسم المستخدم</th><th>الراتب</th><th>صلاحيات</th><th>الحالة</th><th>الإجراءات</th></tr></thead>
              <tbody>
                ${employees.map(function (employee) {
                  return `<tr>
                    <td>${escapeHtml(employee.username)}</td>
                    <td dir="ltr">${formatMoney(employee.monthly_salary)}</td>
                    <td>${[employee.can_sell ? 'بيع' : '', employee.can_manage_inventory ? 'إدارة الأصناف' : '', employee.can_manage_expenses ? 'مصروفات' : '', employee.can_manage_purchases ? 'مشتريات' : '', employee.can_join_existing_shift ? 'وردية متزامنة' : ''].filter(Boolean).join(' / ')}</td>
                    <td>${employee.is_active ? 'نشط' : 'غير نشط'}</td>
                    <td class="actions"><button class="button button-secondary" onclick="editEmployee(${employee.id})">تعديل</button><button class="button button-danger" onclick="toggleEmployeeStatus(${employee.id}, ${employee.is_active ? 0 : 1})">${employee.is_active ? 'إيقاف' : 'تفعيل'}</button><button class="button button-danger" onclick="deleteEmployee(${employee.id})">حذف</button></td>
                  </tr>`;
                }).join("") || '<tr><td colspan="5">لا يوجد موظفين.</td></tr>'}
              </tbody>
            </table>
          </div>
        </article>
      `;
    } catch (error) {
      section.innerHTML = '<article class="panel"><p class="empty-table">تعذر تحميل الموظفين.</p></article>';
      showMessage(error.message);
    }
  }

  window.saveEmployee = async function () {
    var editId = document.getElementById("emp-edit-id")?.value || "";
    var payload = {
      username: document.getElementById("emp-username")?.value || "",
      password: document.getElementById("emp-password")?.value || "",
      monthly_salary: document.getElementById("emp-salary")?.value || 0,
      can_sell: document.getElementById("emp-can-sell")?.checked ? 1 : 0,
      can_manage_expenses: document.getElementById("emp-expenses")?.checked ? 1 : 0,
      can_manage_purchases: document.getElementById("emp-purchases")?.checked ? 1 : 0,
      can_manage_inventory: document.getElementById("emp-inventory")?.checked ? 1 : 0,
      can_join_existing_shift: document.getElementById("emp-join-existing-shift")?.checked ? 1 : 0
    };
    try {
      await apiCall("/api/admin/employees" + (editId ? "/" + editId : ""), {
        method: editId ? "PUT" : "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      showMessage(editId ? "تم تحديث بيانات الموظف." : "تم حفظ الموظف بنجاح.", true);
      await renderEmployeesView();
      resetEmployeeForm();
    } catch (error) {
      showMessage(error.message);
    }
  };

  window.editEmployee = function (employeeId) {
    var employee = employeesCache.filter(function (item) { return Number(item.id) === Number(employeeId); })[0];
    if (!employee) return;
    document.getElementById("emp-edit-id").value = employee.id;
    document.getElementById("emp-username").value = employee.username;
    document.getElementById("emp-password").value = "";
    document.getElementById("emp-salary").value = employee.monthly_salary;
    document.getElementById("emp-can-sell").checked = !!employee.can_sell;
    document.getElementById("emp-expenses").checked = !!employee.can_manage_expenses;
    document.getElementById("emp-purchases").checked = !!employee.can_manage_purchases;
    document.getElementById("emp-inventory").checked = !!employee.can_manage_inventory;
    document.getElementById("emp-join-existing-shift").checked = !!employee.can_join_existing_shift;
    document.getElementById("emp-save-button").textContent = "تحديث الموظف";
    document.getElementById("emp-username").focus();
  };

  window.resetEmployeeForm = function () {
    var form = document.querySelector("#view-employees .employee-form");
    if (!form) return;
    document.getElementById("emp-username").value = "";
    document.getElementById("emp-password").value = "";
    document.getElementById("emp-salary").value = "3000";
    document.getElementById("emp-can-sell").checked = true;
    document.getElementById("emp-expenses").checked = false;
    document.getElementById("emp-purchases").checked = false;
    document.getElementById("emp-inventory").checked = false;
    document.getElementById("emp-join-existing-shift").checked = false;
    var editId = document.getElementById("emp-edit-id");
    var saveButton = document.getElementById("emp-save-button");
    if (editId) editId.value = "";
    if (saveButton) saveButton.textContent = "حفظ الموظف";
  };

  window.deleteEmployee = async function (employeeId) {
    if (!window.confirm("إيقاف حساب الموظف؟ إذا له سجل مالي أو ورديات فسيتم إيقافه مع حفظ السجلات، وإلا سيُحذف نهائيًا.")) return;
    try {
      var deleted = await apiCall("/api/admin/employees/" + employeeId, {method: "DELETE"});
      showMessage(deleted.deactivated ? "تم إيقاف حساب الموظف وحفظ سجلاته." : "تم حذف حساب الموظف.", true);
      await renderEmployeesView();
    } catch (error) {
      showMessage(error.message);
    }
  };

  window.toggleEmployeeStatus = async function (employeeId, status) {
    try {
      await apiCall("/api/admin/employees/" + employeeId, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({is_active: status})
      });
      showMessage("تم تحديث حالة الموظف.", true);
      renderEmployeesView();
    } catch (error) {
      showMessage(error.message);
    }
  };

  function projectReportSalesRows(lines) {
    if (!lines || !lines.length) return '<tr><td colspan="4">لا توجد عمليات بيع.</td></tr>';
    return lines.map(function (line) {
      return `<tr><td>#${escapeHtml(line.order_id)}</td><td>${escapeHtml(line.timestamp_display || formatDateTime(line.timestamp))}</td><td>${escapeHtml(line.item_names || "—")}</td><td dir="ltr">${formatMoney(line.total_amount)}</td></tr>`;
    }).join("");
  }

  function projectReportReturnRows(lines) {
    if (!lines || !lines.length) return '<tr><td colspan="5">لا توجد عمليات مسترجعة.</td></tr>';
    return lines.map(function (line) {
      return `<tr><td>#${escapeHtml(line.order_id)}</td><td>${escapeHtml(line.timestamp_display || formatDateTime(line.timestamp))}</td><td>${escapeHtml(line.item_names || "—")}</td><td>${escapeHtml(line.reason || "بدون سبب")}</td><td dir="ltr">${formatMoney(line.total_amount)}</td></tr>`;
    }).join("");
  }

  function projectReportShiftBlocks(shiftBreakdown) {
    if (!shiftBreakdown || !shiftBreakdown.length) return '<p class="muted">لا توجد ورديات مسجلة لهذا اليوم.</p>';
    return shiftBreakdown.map(function (shift) {
      var range = escapeHtml(shift.started_display || "—") + (shift.ended_display ? " إلى " + escapeHtml(shift.ended_display) : " (مفتوحة)");
      return `<div class="project-shift">
        <h4>الكاشير: ${escapeHtml(shift.username)} — ${range}</h4>
        <p class="muted">مبيعات: <strong dir="ltr">${formatMoney(shift.sales_total)}</strong> (${shift.orders_count} عملية) · مرتجعات: <strong dir="ltr">${formatMoney(shift.returns_total)}</strong> (${shift.returns_count})</p>
        <div class="table-wrap"><table><thead><tr><th>رقم العملية</th><th>الوقت والتاريخ</th><th>الأصناف</th><th>الإجمالي</th></tr></thead><tbody>${projectReportSalesRows(shift.sales)}</tbody></table></div>
        ${shift.returns && shift.returns.length ? `<div class="table-wrap"><table><thead><tr><th>رقم العملية</th><th>الوقت والتاريخ</th><th>الأصناف</th><th>سبب الاسترجاع</th><th>الإجمالي</th></tr></thead><tbody>${projectReportReturnRows(shift.returns)}</tbody></table></div>` : ""}
      </div>`;
    }).join("");
  }

  function buildProjectDetailHtml(report) {
    var expenseRows = (report.expense_rows || []).map(function (row) {
      return `<tr><td>${escapeHtml(row.category)}</td><td dir="ltr">${formatMoney(row.amount)}</td><td>${escapeHtml(row.note || "")}</td></tr>`;
    }).join("") || '<tr><td colspan="3">لا توجد مصروفات.</td></tr>';
    var purchaseRows = (report.purchases || []).map(function (row) {
      return `<tr><td>${escapeHtml(formatDateTime(row.timestamp))}</td><td>${escapeHtml(row.supplier || "")}</td><td>${escapeHtml(row.category || "")}</td><td dir="ltr">${formatMoney(row.amount)}</td></tr>`;
    }).join("") || '<tr><td colspan="4">لا توجد مشتريات.</td></tr>';
    var consumptionRows = (report.consumption_rows || []).map(function (row) {
      return `<tr><td>${escapeHtml(row.name)}</td><td dir="ltr">${row.quantity} ${escapeHtml(row.unit || "")}</td><td dir="ltr">${formatMoney(row.cost)}</td></tr>`;
    }).join("") || '<tr><td colspan="3">لا يوجد استهلاك.</td></tr>';
    var logRows = (report.log || []).map(function (entry) {
      return `<tr><td>${escapeHtml(entry.event_time_display || formatDateTime(entry.event_time))}</td><td>${escapeHtml(entry.title || "")}</td><td>${escapeHtml(entry.details || "")}</td></tr>`;
    }).join("") || '<tr><td colspan="3">لا يوجد سجل.</td></tr>';
    return `
      <h3>تفاصيل يوم ${escapeHtml(formatDateOnly(report.key))}</h3>
      <div class="metric-grid">
        <div class="metric-card"><span>المبيعات</span><strong dir="ltr">${formatMoney(report.revenue)}</strong></div>
        <div class="metric-card"><span>المرتجعات</span><strong dir="ltr">${formatMoney(report.returns_total)}</strong></div>
        <div class="metric-card"><span>المصروفات</span><strong dir="ltr">${formatMoney(report.expenses)}</strong></div>
        <div class="metric-card"><span>المشتريات</span><strong dir="ltr">${formatMoney(report.purchases_total)}</strong></div>
        <div class="metric-card"><span>تكلفة الاستهلاك</span><strong dir="ltr">${formatMoney(report.consumption_cost)}</strong></div>
        <div class="metric-card"><span>صافي الربح</span><strong dir="ltr">${formatMoney(report.profit)}</strong></div>
      </div>
      <h3>الورديات والكاشير</h3>${projectReportShiftBlocks(report.shift_breakdown)}
      <h3>المصروفات</h3><div class="table-wrap"><table><thead><tr><th>البند</th><th>المبلغ</th><th>ملاحظة</th></tr></thead><tbody>${expenseRows}</tbody></table></div>
      <h3>المشتريات</h3><div class="table-wrap"><table><thead><tr><th>الوقت والتاريخ</th><th>المورد</th><th>البند</th><th>المبلغ</th></tr></thead><tbody>${purchaseRows}</tbody></table></div>
      <h3>الاستهلاك</h3><div class="table-wrap"><table><thead><tr><th>المادة</th><th>الكمية</th><th>التكلفة</th></tr></thead><tbody>${consumptionRows}</tbody></table></div>
      <h3>سجل ما حدث</h3><div class="table-wrap"><table><thead><tr><th>الوقت والتاريخ</th><th>الحدث</th><th>التفاصيل</th></tr></thead><tbody>${logRows}</tbody></table></div>
    `;
  }

  async function loadAdminProjectDetail(day, container) {
    if (!container) return;
    container.hidden = false;
    container.innerHTML = '<p class="muted">جارٍ تحميل التفاصيل...</p>';
    try {
      var report = await apiCall("/api/admin/projects/report?period=day&date=" + encodeURIComponent(day));
      container.innerHTML = buildProjectDetailHtml(report);
      container.scrollIntoView();
    } catch (error) {
      container.innerHTML = '<p class="form-message error">تعذر تحميل التفاصيل: ' + escapeHtml(error.message) + '</p>';
    }
  }

  async function renderProjectsView() {
    var section = document.getElementById("view-projects");
    try {
      var projects = await apiCall("/api/admin/projects");
      section.innerHTML = `
        <article class="panel">
          <div class="panel-heading"><h2>المشاريع / أيام العمل</h2></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>التاريخ</th><th>المبيعات</th><th>المصروفات</th><th>الرصيد النقدي</th><th>الاختلاف</th><th>الحالة</th><th>التفاصيل</th></tr></thead>
              <tbody>
                ${projects.map(function (project) {
                  return `<tr>
                    <td>${formatDateOnly(project.project_date)}</td>
                    <td dir="ltr">${formatMoney(project.sales)}</td>
                    <td dir="ltr">${formatMoney(project.expenses)}</td>
                    <td dir="ltr">${formatMoney(project.cash_balance)}</td>
                    <td dir="ltr" class="${(project.closing_variance || 0) >= 0 ? 'text-positive' : 'text-negative'}">${formatMoney(project.closing_variance || 0)}</td>
                    <td>${project.status === 'open' ? 'مفتوح' : 'مغلق'}</td>
                    <td><button class="button button-secondary small-btn" data-project-day="${escapeHtml(project.project_date)}">عرض التفاصيل</button></td>
                  </tr>`;
                }).join("") || '<tr><td colspan="7">لا توجد أيام عمل.</td></tr>'}
              </tbody>
            </table>
          </div>
          <div id="admin-project-detail" class="project-detail" hidden></div>
        </article>
      `;
      var detailBody = document.getElementById("admin-project-detail");
      section.querySelectorAll("[data-project-day]").forEach(function (button) {
        button.addEventListener("click", function () {
          loadAdminProjectDetail(button.getAttribute("data-project-day"), detailBody);
        });
      });
    } catch (error) {
      section.innerHTML = '<article class="panel"><p class="empty-table">تعذر تحميل المشاريع.</p></article>';
      showMessage(error.message);
    }
  }

  async function renderAttendanceView() {
    var section = document.getElementById("view-attendance");
    var dateInput = document.getElementById("attendance-date");
    var initialDate = dateInput && dateInput.value ? dateInput.value : localTodayIso();
    try {
      var payload = await apiCall("/api/admin/attendance?date=" + encodeURIComponent(initialDate));
      var permissionLabels = [
        ["can_sell", "بيع"],
        ["can_manage_inventory", "إدارة الأصناف"],
        ["can_manage_expenses", "إدارة المصروفات"],
        ["can_manage_purchases", "إدارة المشتريات"]
      ];
      function permissionsFor(employee) {
        return permissionLabels.filter(function (item) {
          return !!employee[item[0]];
        }).map(function (item) {
          return item[1];
        }).join(" / ") || "بدون صلاحيات تشغيلية";
      }
      section.innerHTML = `
        <article class="panel">
          <div class="panel-heading"><h2>الحضور والورديات</h2><div class="inventory-heading-actions"><label for="attendance-date">التاريخ</label><input id="attendance-date" type="date" value="${escapeHtml(payload.date)}"></div></div>
          <p class="muted small">الوردية المحددة: ${payload.shift_hours} ساعات</p>
          <h3>الموظفون المتواجدون الآن</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>الموظف</th><th>الصلاحيات</th><th>بداية الوردية</th><th>الدرج</th><th>إجراء</th></tr></thead>
            <tbody>${(payload.open_shifts || []).map(function (shift) {
              return `<tr><td>${escapeHtml(shift.username)}</td><td>${escapeHtml(permissionsFor(shift))}</td><td>${escapeHtml(formatDateTime(shift.started_at))}</td><td>مشترك</td><td><button type="button" class="button button-danger small-btn" data-close-shift="${Number(shift.shift_id)}" data-cash-reconciliation="${shift.cash_reconciliation_required ? "true" : "false"}">إنهاء وردية</button></td></tr>`;
            }).join("") || '<tr><td colspan="5">لا يوجد موظفون على وردية مفتوحة.</td></tr>'}</tbody>
          </table></div>
          <h3>سجل الورديات في التاريخ المحدد</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>الموظف</th><th>الصلاحيات</th><th>تسجيل الحضور</th><th>تسجيل الانصراف</th><th>رصيد بداية الوردية</th><th>الحالة</th></tr></thead>
            <tbody>${payload.shifts.map(function (shift) {
              return `<tr><td>${escapeHtml(shift.username)}</td><td>${escapeHtml(permissionsFor(shift))}</td><td>${escapeHtml(formatDateTime(shift.started_at))}</td><td>${shift.ended_at ? escapeHtml(formatDateTime(shift.ended_at)) : "—"}</td><td dir="ltr">${formatMoney(shift.opening_cash)}</td><td>${shift.status === "open" ? "مفتوحة" : "مغلقة"}</td></tr>`;
            }).join("") || '<tr><td colspan="6">لا توجد ورديات مسجلة اليوم.</td></tr>'}</tbody>
          </table></div>
          <div class="table-wrap"><table><thead><tr><th>الموظف</th><th>الحضور في التاريخ</th><th>الحالة</th></tr></thead>
          <tbody>${(payload.employees || []).map(function (employee) {
            return `<tr><td>${escapeHtml(employee.username)}</td><td>${employee.attended ? "حضر" : "لم يسجل حضورًا"}</td><td>${employee.is_active ? "نشط" : "متوقف"}</td></tr>`;
          }).join("") || '<tr><td colspan="3">لا يوجد موظفون مسجلون.</td></tr>'}</tbody></table></div>
          <div id="attendance-close-modal" class="cat-modal" hidden></div>
        </article>`;
      var attendanceDateInput = document.getElementById("attendance-date");
      if (attendanceDateInput) {
        attendanceDateInput.addEventListener("change", function () {
          renderAttendanceView();
        });
      }
      section.onclick = async function (event) {
        var target = event.target.closest ? event.target.closest("[data-close-shift], [data-attendance-close-cancel], [data-attendance-close-submit]") : null;
        var modal = document.getElementById("attendance-close-modal");
        var countedInput;
        var body;
        if (!target || !modal) return;
        if (target.hasAttribute("data-attendance-close-cancel")) {
          modal.hidden = true;
          modal.innerHTML = "";
          return;
        }
        if (target.hasAttribute("data-attendance-close-submit")) {
          countedInput = modal.querySelector("#attendance-close-counted-cash");
          body = {};
          if (target.getAttribute("data-requires-cash") === "true") {
            if (!countedInput || !countedInput.value.trim()) {
              showMessage("رصيد الدرج المعدود مطلوب لإنهاء آخر وردية.");
              if (countedInput) countedInput.focus();
              return;
            }
            body.counted_cash = countedInput.value;
          }
          target.disabled = true;
          try {
            await apiCall("/api/admin/attendance/" + target.getAttribute("data-shift-id") + "/close", {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify(body)
            });
            modal.hidden = true;
            modal.innerHTML = "";
            showMessage("تم إنهاء وردية الموظف «" + target.getAttribute("data-employee-name") + "» فقط.", true);
            await renderAttendanceView();
          } catch (error) {
            target.disabled = false;
            showMessage("تعذر إنهاء الوردية: " + error.message);
          }
          return;
        }
        var row = target.closest("tr");
        var employeeName = row ? row.cells[0].textContent : "الموظف";
        var requiresCash = target.getAttribute("data-cash-reconciliation") === "true";
        modal.innerHTML = '<div class="cat-modal-backdrop"><section class="cat-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="attendance-close-title">' +
          '<h3 id="attendance-close-title">إنهاء وردية «' + escapeHtml(employeeName) + '»</h3>' +
          '<p>سيتم إنهاء وردية هذا الموظف فقط، مع إبقاء ورديات باقي الموظفين مفتوحة.</p>' +
          (requiresCash
            ? '<label for="attendance-close-counted-cash">رصيد الدرج المشترك المعدود</label><input id="attendance-close-counted-cash" type="number" min="0" step="0.01" required>'
            : '<p class="muted">تتم تسوية الدرج عند إنهاء آخر وردية مفتوحة.</p>') +
          '<div class="cat-modal-actions"><button type="button" class="button button-danger" data-attendance-close-submit data-shift-id="' +
          Number(target.getAttribute("data-close-shift")) + '" data-employee-name="' + escapeHtml(employeeName) +
          '" data-requires-cash="' + requiresCash + '">تأكيد إنهاء الوردية</button>' +
          '<button type="button" class="button button-secondary" data-attendance-close-cancel>إلغاء</button></div></section></div>';
        modal.hidden = false;
        if (requiresCash) modal.querySelector("#attendance-close-counted-cash").focus();
      };
    } catch (error) {
      section.innerHTML = '<article class="panel"><p class="empty-table">تعذر تحميل سجل الحضور.</p></article>';
      showMessage(error.message);
    }
  }

  async function renderPayrollView() {
    var section = document.getElementById("view-payroll");
    var month = new Date().toISOString().slice(0, 7);
    try {
      var payload = await apiCall("/api/admin/payroll?month=" + encodeURIComponent(month));
      section.innerHTML = `
        <article class="panel">
          <div class="panel-heading"><h2>الرواتب</h2></div>
          <div class="admin-form">
            <div class="field"><label>الشهر</label><input type="month" id="payroll-month" value="${month}"></div>
            <div class="field form-actions"><button class="button button-primary" onclick="loadPayrollForCurrentMonth()">عرض الرواتب</button><button class="button button-secondary" onclick="settlePayroll()">تسوية الراتب</button></div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>الموظف</th><th>الراتب</th><th>العمل</th><th>الوردية</th><th>المبلغ</th></tr></thead>
              <tbody>
                ${payload.entries.map(function (row) {
                  return `<tr><td>${escapeHtml(row.username)}</td><td dir="ltr">${formatMoney(row.monthly_salary)}</td><td dir="ltr">${formatMinutes(row.worked_seconds)}</td><td dir="ltr">${row.completed_shifts}</td><td dir="ltr">${formatMoney(row.amount)}</td></tr>`;
                }).join("") || '<tr><td colspan="5">لا توجد بيانات شهرية.</td></tr>'}
              </tbody>
            </table>
            <p class="muted mt-2">الإجمالي: <strong dir="ltr">${formatMoney(payload.total)}</strong></p>
          </div>
        </article>
      `;
    } catch (error) {
      section.innerHTML = '<article class="panel"><p class="empty-table">تعذر تحميل الرواتب.</p></article>';
      showMessage(error.message);
    }
  }

  window.loadPayrollForCurrentMonth = async function () {
    var month = document.getElementById("payroll-month")?.value || new Date().toISOString().slice(0, 7);
    var section = document.getElementById("view-payroll");
    try {
      var payload = await apiCall("/api/admin/payroll?month=" + encodeURIComponent(month));
      section.innerHTML = `
        <article class="panel">
          <div class="panel-heading"><h2>الرواتب</h2></div>
          <div class="admin-form"><div class="field"><label>الشهر</label><input type="month" id="payroll-month" value="${month}"></div><div class="field form-actions"><button class="button button-primary" onclick="loadPayrollForCurrentMonth()">عرض الرواتب</button><button class="button button-secondary" onclick="settlePayroll()">تسوية الراتب</button></div></div>
          <div class="table-wrap"><table><thead><tr><th>الموظف</th><th>الراتب</th><th>العمل</th><th>الوردية</th><th>المبلغ</th></tr></thead><tbody>${payload.entries.map(function (row) { return `<tr><td>${escapeHtml(row.username)}</td><td dir="ltr">${formatMoney(row.monthly_salary)}</td><td dir="ltr">${formatMinutes(row.worked_seconds)}</td><td dir="ltr">${row.completed_shifts}</td><td dir="ltr">${formatMoney(row.amount)}</td></tr>`; }).join("") || '<tr><td colspan="5">لا توجد بيانات شهرية.</td></tr>'}</tbody></table><p class="muted mt-2">الإجمالي: <strong dir="ltr">${formatMoney(payload.total)}</strong></p></div></article>`;
    } catch (error) {
      showMessage(error.message);
    }
  };

  window.settlePayroll = async function () {
    var month = document.getElementById("payroll-month")?.value || new Date().toISOString().slice(0, 7);
    try {
      await apiCall("/api/admin/payroll/settle?month=" + encodeURIComponent(month), {method: "POST"});
      showMessage("تمت تسوية الرواتب بنجاح.", true);
      loadPayrollForCurrentMonth();
    } catch (error) {
      showMessage(error.message);
    }
  };

  function bindAdminGlobalSearch() {
    var input = document.getElementById("admin-global-search");
    var results = document.getElementById("admin-search-results");
    var timer = null;
    if (!input || !results) return;

    input.addEventListener("input", function () {
      var query = input.value.replace(/^\s+|\s+$/g, "");
      if (timer) clearTimeout(timer);
      if (!query) {
        results.hidden = true;
        results.innerHTML = "";
        return;
      }
      timer = setTimeout(async function () {
        try {
          var matches = await apiCall("/api/search?scope=admin&q=" + encodeURIComponent(query));
          results.innerHTML = matches.map(function (item) {
            return '<button type="button" class="global-search-result" role="option" data-result-view="' +
              escapeHtml(item.view) + '" data-result-type="' + escapeHtml(item.type) +
              '" data-result-query="' + escapeHtml(item.query || "") + '"><strong>' +
              escapeHtml(item.label) + '</strong><small>' + escapeHtml(item.path) + '</small></button>';
          }).join("") || '<div class="global-search-empty">لا توجد نتائج مطابقة.</div>';
          results.hidden = false;
        } catch (error) {
          results.innerHTML = '<div class="global-search-empty">تعذر البحث: ' + escapeHtml(error.message) + '</div>';
          results.hidden = false;
        }
      }, 180);
    });

    results.addEventListener("click", function (event) {
      var button = event.target.closest("[data-result-view]");
      if (!button) return;
      var view = button.getAttribute("data-result-view");
      var type = button.getAttribute("data-result-type");
      var query = button.getAttribute("data-result-query");
      results.hidden = true;
      input.value = "";
      if (view === "pos") {
        window.location.href = "/";
        return;
      }
      var viewTask = switchView(view);
      if (type === "product" && query) {
        Promise.resolve(viewTask).then(function () {
          var inputId = {books: "books-search", drinks: "drinks-search", materials: "materials-search", retail: "retail-search"}[view];
          var target = inputId && document.getElementById(inputId);
          if (target) {
            target.value = query;
            target.dispatchEvent(new Event("input", {bubbles: true}));
          }
        }, 250);
      }
    });

    document.addEventListener("click", function (event) {
      if (!input.contains(event.target) && !results.contains(event.target)) results.hidden = true;
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape") results.hidden = true;
    });
  }

  // ==========================================
  // BOOKS VIEW (With Functional Edit Button)
  // ==========================================
  function renderBooksTable(rows, noResults) {
    if (!rows.length) {
      return '<p class="empty-table">' + (noResults ? "لا توجد نتائج." : "لا توجد كتب مضافة بعد.") + '</p>';
    }
    return '<div class="table-wrap"><table><thead><tr><th>العنوان</th><th>المؤلف</th><th>دار النشر</th><th>النوع</th><th>التكلفة</th><th>السعر</th><th>المخزون</th><th>الإجراءات</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return `<tr><td>${escapeHtml(row.title)}</td>
          <td>${escapeHtml(row.author)}</td><td>${escapeHtml(row.publisher || "")}</td>
          <td><span class="book-type-tag ${row.type === "Original" ? "original" : "copy"}" dir="ltr">${escapeHtml(row.type)}</span></td>
          <td dir="ltr">${formatMoney(row.cost_price)}</td><td dir="ltr">${formatMoney(row.sell_price)}</td>
          <td dir="ltr">${row.stock_quantity}</td><td class="actions">
            <button class="button button-secondary small-btn" onclick="editBook(${Number(row.id)})">تعديل</button>
            <button class="button button-danger small-btn" onclick="deleteRecord('books', ${Number(row.id)}, loadBooksView)">حذف</button>
          </td></tr>`;
      }).join("") + "</tbody></table></div>";
  }

  async function loadBooksView() {
    var section = document.getElementById("view-books");
    try {
      var rows = await apiCall("/api/admin/books");
      
      var tableHtml = renderBooksTable(rows, false);

      // Form Markup for Adding/Editing Book
      var formHtml = `
        <form id="book-form" class="admin-form" style="display:none;">
          <input type="hidden" id="bk-edit-id"> <!-- Hidden field to store ID during edit -->
          
          <div class="field"><label>العنوان</label><input type="text" id="bk-title"></div>
          <div class="field"><label>المؤلف</label><input type="text" id="bk-author"></div>
          <div class="field"><label>دار النشر</label><input type="text" id="bk-publisher"></div>
          <div class="field">
            <label>النوع *</label>
            <select id="bk-type">
              <option value="Original">Original</option>
              <option value="High Copy">High Copy</option>
            </select>
          </div>
          <div class="field"><label>سعر التكلفة</label><input type="number" step="0.01" min="0" id="bk-cost"></div>
          <div class="field"><label>سعر البيع</label><input type="number" step="0.01" min="0" id="bk-price"></div>
          <div class="field"><label>كمية المخزون</label><input type="number" min="0" id="bk-stock"></div>
          <div class="form-actions">
            <button type="submit" class="button button-primary" id="bk-submit-btn">حفظ الكتاب</button>
            <button type="button" class="button button-secondary" onclick="document.getElementById('book-form').style.display='none'; resetBookForm();">إلغاء</button>
          </div>
        </form>
      `;

      section.innerHTML = `
        <article class="panel">
          <div class="panel-heading">
            <h2>مخزون الكتب</h2>
            <div class="inventory-heading-actions">
              <input id="books-search" class="search-box-inventory" type="search" placeholder="ابحث في الكتب..." aria-label="البحث في الكتب">
              ${renderImportControls("books")}
              <button class="button button-primary" onclick="toggleForm('book-form'); resetBookForm();">+ إضافة كتاب</button>
            </div>
          </div>
          ${formHtml}
          <div id="books-table-content">${tableHtml}</div>
        </article>
      `;
      bindInventorySearch(
        "books-search", "books-table-content", rows,
        function (row) { return [row.title, row.author, row.publisher, row.type].join(" "); },
        renderBooksTable
      );

      // Bind Submit Event (Handles both Add and Edit)
      document.getElementById("book-form").addEventListener("submit", async function(e) {
        e.preventDefault();
        
        var editId = document.getElementById("bk-edit-id").value;
        var payload = {
          title: document.getElementById("bk-title").value,
          author: document.getElementById("bk-author").value,
          publisher: document.getElementById("bk-publisher").value,
          type: document.getElementById("bk-type").value,
          cost_price: document.getElementById("bk-cost").value || 0,
          sell_price: document.getElementById("bk-price").value || 0,
          stock_quantity: document.getElementById("bk-stock").value || 0
        };
        
        try {
          var url = "/api/admin/books";
          var method = "POST";

          if (editId) {
             url += "/" + editId;
             method = "PUT";
          }

          await apiCall(url, { 
              method: method, 
              headers: {"Content-Type":"application/json"}, 
              body: JSON.stringify(payload) 
          });
          
          showMessage(editId ? "تم تحديث الكتاب." : "تم حفظ الكتاب.", true);
          
          // Reset and hide form
          this.style.display = 'none';
          resetBookForm();
          
          await loadBooksView(); // Refresh table
          // Ask an open cashier tab to reload the catalog immediately.
          try {
            window.dispatchEvent(new Event("storage"));
            if (window.BroadcastChannel) {
              var catalogChannel = new BroadcastChannel("bookmart-catalog");
              catalogChannel.postMessage({type: "catalog-updated", resource: "books"});
              catalogChannel.close();
            }
          } catch (error) {}
          
        } catch(err) { 
            showMessage(err.message); 
        }
      });
      bindImportControls("books");

    } catch (error) { section.innerHTML = `<p>حدث خطأ: ${escapeHtml(error.message)}</p>`; }
  }
  window.loadBooksView = loadBooksView;

  // Helper to clear form fields when switching between Add/Edit modes
  window.resetBookForm = function() {
      var form = document.getElementById("book-form");
      if(form) {
          form.reset();
          document.getElementById("bk-edit-id").value = "";
          document.getElementById("bk-submit-btn").textContent = "حفظ الكتاب";
      }
  };

  // Global helper for editing book (NOW FUNCTIONAL)
  window.editBook = async function(id) {
     try {
        // 1. Fetch the specific book data from backend list
        var rows = await apiCall("/api/admin/books");
        var bookToEdit = rows.find(b => b.id === id);

        if (!bookToEdit) {
            alert("الكتاب غير موجود.");
            return;
        }

        // 2. Populate the Form Fields with existing data
        document.getElementById("bk-edit-id").value = bookToEdit.id;
        document.getElementById("bk-title").value = bookToEdit.title || "";
        document.getElementById("bk-author").value = bookToEdit.author || "";
        document.getElementById("bk-publisher").value = bookToEdit.publisher || "";
        document.getElementById("bk-type").value = bookToEdit.type || "Original";
        document.getElementById("bk-cost").value = bookToEdit.cost_price || 0;
        document.getElementById("bk-price").value = bookToEdit.sell_price || 0;
        document.getElementById("bk-stock").value = bookToEdit.stock_quantity || 0;

        // 3. Show the form and change button text
        var form = document.getElementById("book-form");
        form.style.display = "grid"; 
        
        var submitBtn = document.getElementById("bk-submit-btn");
        if(submitBtn) submitBtn.textContent = "تحديث الكتاب";

        // Scroll to top of panel smoothly
        document.querySelector("#view-books .panel-heading").scrollIntoView({ behavior: 'smooth' });

     } catch (error) {
         console.error(error);
         alert("تعذّر تحميل بيانات الكتاب: " + error.message);
     }
  };

  // ==========================================
  // DRINK RECIPE MATERIAL PICKER
  // ==========================================
  function setRecipeRowError(rowState, text) {
    if (!rowState || !rowState.error) return;
    rowState.error.textContent = text || "";
    rowState.error.style.display = text ? "block" : "none";
    setClassFlag(rowState.element, "has-error", !!text);
    if (rowState.picker) rowState.picker.showError(text);
  }

  function addRecipeRow(prefill) {
    var container = document.getElementById("recipe-rows");
    var row;
    var pickerHost;
    var quantityInput;
    var removeButton;
    var error;
    var rowState;
    if (!container) return null;

    row = document.createElement("div");
    row.className = "recipe-row";
    pickerHost = document.createElement("div");
    pickerHost.className = "recipe-material-host";
    quantityInput = document.createElement("input");
    quantityInput.type = "number";
    quantityInput.className = "recipe-quantity";
    quantityInput.min = "0.001";
    quantityInput.step = "any";
    quantityInput.placeholder = "الكمية";
    quantityInput.setAttribute("aria-label", "كمية المكوّن");
    removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "recipe-remove";
    removeButton.textContent = "×";
    removeButton.setAttribute("aria-label", "حذف المكوّن");
    error = document.createElement("small");
    error.className = "recipe-row-error";
    error.style.display = "none";
    row.appendChild(pickerHost);
    row.appendChild(quantityInput);
    row.appendChild(removeButton);
    row.appendChild(error);
    container.appendChild(row);

    rowState = {
      element: row,
      picker: null,
      quantity: quantityInput,
      error: error
    };
    rowState.picker = createMaterialPicker(pickerHost, {
      allowFreeText: false,
      initialValueId: prefill && prefill.material_id,
      onChange: function (material, value) {
        if (material) setRecipeRowError(rowState, "");
        else if (String(value || "").replace(/^\s+|\s+$/g, "")) {
          setRecipeRowError(rowState, "المادة غير مسجلة — أضفها أولاً من صفحة المواد.");
        } else {
          setRecipeRowError(rowState, "");
        }
      }
    });
    if (prefill && prefill.qty !== undefined && prefill.qty !== null) {
      quantityInput.value = prefill.qty;
    }
    quantityInput.addEventListener("input", function () {
      if (Number(quantityInput.value) > 0) setRecipeRowError(rowState, "");
    });
    removeButton.addEventListener("click", function () {
      rowState.picker.destroy();
      recipeRowStates = recipeRowStates.filter(function (item) { return item !== rowState; });
      row.parentNode.removeChild(row);
    });
    recipeRowStates.push(rowState);
    return rowState;
  }

  function collectRecipeRows() {
    var recipe = [];
    var valid = true;
    var i;
    var rowState;
    var material;
    var quantity;
    for (i = 0; i < recipeRowStates.length; i += 1) {
      rowState = recipeRowStates[i];
      material = rowState.picker.getSelected();
      quantity = Number(rowState.quantity.value);
      if (!material) {
        valid = false;
        if (rowState.picker.input.value.replace(/^\s+|\s+$/g, "")) {
          setRecipeRowError(rowState, "المادة غير مسجلة — أضفها أولاً من صفحة المواد.");
        } else {
          setRecipeRowError(rowState, "اختر مادة مسجلة.");
        }
      } else if (!isFinite(quantity) || quantity <= 0) {
        valid = false;
        setRecipeRowError(rowState, "أدخل كمية أكبر من صفر.");
      } else {
        setRecipeRowError(rowState, "");
        recipe.push({material_id: Number(material.id), qty: quantity});
      }
    }
    return valid ? recipe : null;
  }

  function clearRecipeRows() {
    var i;
    for (i = 0; i < recipeRowStates.length; i += 1) {
      recipeRowStates[i].picker.destroy();
    }
    recipeRowStates = [];
    var container = document.getElementById("recipe-rows");
    if (container) container.innerHTML = "";
  }

  async function saveDrinkHandler(event) {
    event.preventDefault();
    var form = document.getElementById("drink-form");
    var editId = document.getElementById("dk-edit-id").value;
    var recipe = collectRecipeRows();
    var price = Number(document.getElementById("dk-price").value || 0);
    var payload;
    if (!recipe) {
      showMessage("يرجى تصحيح مكونات الوصفة المحددة قبل الحفظ.");
      return;
    }
    if (!isFinite(price) || price < 0) {
      showMessage("أدخل سعرًا صالحًا للمشروب.");
      return;
    }
    payload = {
      name: document.getElementById("dk-name").value,
      sell_price: price,
      recipe_json: JSON.stringify(recipe),
      category: document.getElementById("dk-category").value
    };
    try {
      await apiCall("/api/admin/drinks" + (editId ? "/" + editId : ""), {
        method: editId ? "PUT" : "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      showMessage(editId ? "تم تحديث المشروب." : "تم حفظ المشروب.", true);
      closeDrinkForm();
      form.reset();
      await loadDrinksView();
    } catch (error) {
      showMessage(error.message);
    }
  }

  function closeDrinkForm() {
    var form = document.getElementById("drink-form");
    clearRecipeRows();
    if (form) form.style.display = "none";
  }

  function openNewDrinkForm() {
    var form = document.getElementById("drink-form");
    if (!form) return;
    clearRecipeRows();
    form.reset();
    document.getElementById("dk-edit-id").value = "";
    document.getElementById("dk-submit-btn").textContent = "حفظ المشروب";
    form.style.display = "grid";
  }

  window.editDrink = function (id) {
    var drink = null;
    var i;
    var recipe;
    var form = document.getElementById("drink-form");
    if (!form) return;
    for (i = 0; i < drinkRowsCache.length; i += 1) {
      if (String(drinkRowsCache[i].id) === String(id)) {
        drink = drinkRowsCache[i];
        break;
      }
    }
    if (!drink) {
      showMessage("المشروب غير موجود. حدّث صفحة المشروبات ثم حاول مرة أخرى.");
      return;
    }
    clearRecipeRows();
    document.getElementById("dk-edit-id").value = drink.id;
    document.getElementById("dk-name").value = drink.name || "";
    document.getElementById("dk-price").value = drink.sell_price;
    preserveSelectedDrinkCategory(drink);
    document.getElementById("dk-submit-btn").textContent = "تحديث المشروب";
    form.style.display = "grid";
    try {
      recipe = JSON.parse(drink.recipe_json || "[]");
      if (!Array.isArray(recipe)) throw new Error("صيغة الوصفة غير صالحة.");
    } catch (error) {
      recipe = [];
    }
    for (i = 0; i < recipe.length; i += 1) addRecipeRow(recipe[i]);
    var heading = document.querySelector("#view-drinks .panel-heading");
    if (heading && heading.scrollIntoView) heading.scrollIntoView({behavior: "smooth"});
  };

  function renderDrinksTable(rows, noResults) {
    if (!rows.length) {
      return '<p class="empty-table">' + (noResults ? "لا توجد نتائج." : "لا توجد مشروبات مسجلة بعد.") + '</p>';
    }
    return '<div class="table-wrap"><table><thead><tr><th>الاسم</th><th>النوع</th><th>السعر</th><th>عدد المكونات</th><th>الإجراءات</th></tr></thead><tbody>' +
      rows.map(function (row) {
        var count = 0;
        try {
          var parsed = JSON.parse(row.recipe_json || "[]");
          count = Array.isArray(parsed) ? parsed.length : 0;
        } catch (error) {
          count = 0;
        }
        return '<tr><td>' + escapeHtml(row.name) +
          '</td><td><span class="drink-type-tag">' + escapeHtml(categoryLabel(row.category === "cold" ? "iced" : row.category)) +
          '</span></td><td dir="ltr">' + formatMoney(row.sell_price) +
          '</td><td dir="ltr">' + count + ' مكونات</td><td class="actions">' +
          '<button class="button button-secondary small-btn" onclick="editDrink(' + Number(row.id) + ')">تعديل</button> ' +
          '<button class="button button-danger small-btn" onclick="deleteRecord(\'drinks\', ' + Number(row.id) + ', loadDrinksView)">حذف</button></td></tr>';
      }).join("") + "</tbody></table></div>";
  }

  async function loadDrinksView() {
    var section = document.getElementById("view-drinks");
    disposeMaterialPickers();
    recipeRowStates = [];
    try {
      var rows = await apiCall("/api/admin/drinks");
      window.allMaterialsCache = await apiCall("/api/admin/materials");
      await loadCategoriesCache();
      drinkRowsCache = rows;
      var tableHtml = renderDrinksTable(rows, false);

      section.innerHTML =
        '<article class="panel"><div class="panel-heading"><h2>قائمة المشروبات</h2>' +
        '<div class="inventory-heading-actions">' + renderImportControls("drinks") +
        '<input id="drinks-search" class="search-box-inventory" type="search" placeholder="ابحث في المشروبات..." aria-label="البحث في المشروبات">' +
        '<button type="button" class="button button-primary" onclick="openNewDrinkForm()">+ إضافة مشروب</button></div></div>' +
        '<form id="drink-form" class="admin-form recipe-builder" style="display:none;">' +
        '<input type="hidden" id="dk-edit-id">' +
        '<div class="field field-wide"><label for="dk-name">اسم المشروب</label><input type="text" id="dk-name" placeholder="مثال: لاتيه"></div>' +
        '<div class="field"><label for="dk-category">تصنيف المشروب</label><div class="cat-select-row"><select id="dk-category">' +
        renderCategoryOptions("drink", "hot") + '</select><button type="button" id="dk-new-category-toggle" class="button button-secondary cat-add-button">➕ تصنيف</button></div>' +
        '<div id="dk-new-category" class="cat-inline-create" hidden><input id="dk-new-category-label" type="text" maxlength="80" placeholder="اسم التصنيف الجديد">' +
        '<button type="button" id="dk-new-category-submit" class="button button-primary small-btn">إضافة</button></div></div>' +
        '<div class="field"><label for="dk-price">سعر البيع (ج.م)</label><input type="number" step="0.01" min="0" id="dk-price"></div>' +
        '<div class="field field-wide"><label>مكونات الوصفة</label><div id="recipe-rows" class="recipe-rows"></div>' +
        '<button type="button" id="add-ingredient" class="button button-secondary recipe-add">+ إضافة مكوّن</button></div>' +
        '<div class="form-actions"><button type="submit" class="button button-primary" id="dk-submit-btn">حفظ المشروب</button>' +
        '<button type="button" class="button button-secondary" id="dk-cancel">إلغاء</button></div></form>' +
        '<div id="drinks-table-content">' + tableHtml + '</div></article>';

      bindInventorySearch(
        "drinks-search", "drinks-table-content", rows,
        function (row) { return [row.name, categoryLabel(row.category === "cold" ? "iced" : row.category)].join(" "); },
        renderDrinksTable
      );
      document.getElementById("drink-form").addEventListener("submit", saveDrinkHandler);
      document.getElementById("add-ingredient").addEventListener("click", function () { addRecipeRow(); });
      document.getElementById("dk-cancel").addEventListener("click", closeDrinkForm);
      bindInlineCategoryCreator("drink", "dk");
      bindImportControls("drinks");
    } catch (error) {
      section.innerHTML = '<p>حدث خطأ: ' + escapeHtml(error.message) + '</p>';
    }
  }
  window.loadDrinksView = loadDrinksView;
  window.openNewDrinkForm = openNewDrinkForm;

  // ==========================================
  // MATERIALS VIEW
  // ==========================================
  function similarMaterial(value) {
    var query = String(value || "").replace(/^\s+|\s+$/g, "").toLowerCase();
    var materials = window.allMaterialsCache || [];
    var i;
    var name;
    var prefixLength;
    if (query.length < 1) return null;
    for (i = 0; i < materials.length; i += 1) {
      name = String(materials[i].name || "").replace(/^\s+|\s+$/g, "").toLowerCase();
      if (!name || name === query) continue;
      prefixLength = 0;
      while (prefixLength < query.length && prefixLength < name.length &&
             query.charAt(prefixLength) === name.charAt(prefixLength)) prefixLength += 1;
      if (prefixLength >= 3 || name.indexOf(query) >= 0 || query.indexOf(name) >= 0) return materials[i];
    }
    return null;
  }

  function setMaterialSubmitLabel(text) {
    var button = document.getElementById("mt-submit-btn");
    if (button) button.textContent = text;
  }

  function fillMaterialFields(material) {
    document.getElementById("mt-edit-id").value = material.id;
    document.getElementById("mt-unit").value = {g: "g", kg: "kg", ml: "ml", L: "L", pcs: "pcs"}[material.unit] || "";
    var unitHint = document.getElementById("mt-unit-hint");
    if (unitHint) {
      unitHint.textContent = material.unit_needs_review
        ? "وحدة قديمة غير معروفة؛ اختر وحدة معتمدة قبل الحفظ."
        : "";
      unitHint.className = "material-name-hint" + (material.unit_needs_review ? " similar-warning" : "");
    }
    document.getElementById("mt-cost").value = material.cost_per_unit;
    document.getElementById("mt-stock").value = material.current_stock;
    document.getElementById("mt-reorder").value = material.reorder_level;
    var purchaseUnit = document.getElementById("mt-purchase-unit");
    var usageUnit = document.getElementById("mt-usage-unit");
    if (purchaseUnit) purchaseUnit.value = material.purchase_unit || material.unit || "pcs";
    if (usageUnit) usageUnit.value = material.usage_unit || material.unit || "pcs";
    var reorderHint = document.getElementById("mt-reorder-hint");
    if (reorderHint) reorderHint.textContent = "الحد مقدر بوحدة الاستخدام: " + (usageUnit ? usageUnit.options[usageUnit.selectedIndex].text : "");
    setMaterialSubmitLabel("تحديث المادة");
    var hint = document.getElementById("mt-name-hint");
    hint.textContent = "تم اختيار مادة موجودة — سيؤدي الحفظ إلى تحديثها وليس إنشاء مادة مكررة.";
    hint.className = "material-name-hint similar-found";
  }

  function handleMaterialNameChange(material, value) {
    var editField = document.getElementById("mt-edit-id");
    var hint = document.getElementById("mt-name-hint");
    if (!editField || !hint || material) return;
    if (editField.value) {
      if (editingMaterial) {
        hint.textContent = "سيتم حفظ الاسم الجديد للمادة الحالية.";
        hint.className = "material-name-hint";
        return;
      }
      editField.value = "";
      document.getElementById("mt-unit").value = "";
      document.getElementById("mt-cost").value = "";
      document.getElementById("mt-stock").value = "";
      document.getElementById("mt-reorder").value = "5";
      var unitHint = document.getElementById("mt-unit-hint");
      if (unitHint) unitHint.textContent = "";
      setMaterialSubmitLabel("حفظ المادة");
    }
    var match = similarMaterial(value);
    if (match) {
      hint.textContent = "توجد مادة مشابهة: " + match.name + ". هل أنت متأكد أن هذه مادة جديدة؟";
      hint.className = "material-name-hint similar-warning";
    } else {
      hint.textContent = "";
      hint.className = "material-name-hint";
    }
  }

  function initializeMaterialNamePicker(initialId) {
    var host = document.getElementById("mt-name-picker");
    if (!host) return;
    if (materialNamePicker) materialNamePicker.destroy();
    host.innerHTML = "";
    materialNamePicker = createMaterialPicker(host, {
      inputId: "mt-name",
      allowFreeText: true,
      required: false,
      onSelect: fillMaterialFields,
      onChange: handleMaterialNameChange
    });
    if (initialId !== undefined && initialId !== null) materialNamePicker.setSelected(initialId);
  }

  function resetMaterialsForm() {
    var form = document.getElementById("mat-form");
    if (!form) return;
    if (materialNamePicker) {
      materialNamePicker.destroy();
      materialNamePicker = null;
    }
    editingMaterial = false;
    form.reset();
    document.getElementById("mt-edit-id").value = "";
    document.getElementById("mt-reorder").value = "5";
    setMaterialSubmitLabel("حفظ المادة");
    var hint = document.getElementById("mt-name-hint");
    if (hint) {
      hint.textContent = "";
      hint.className = "material-name-hint";
    }
    var host = document.getElementById("mt-name-picker");
    if (host) host.innerHTML = "";
  }
  window.resetMaterialsForm = resetMaterialsForm;

  function openNewMaterialForm() {
    var form = document.getElementById("mat-form");
    if (!form) return;
    resetMaterialsForm();
    form.style.display = "grid";
    initializeMaterialNamePicker();
  }
  window.openNewMaterialForm = openNewMaterialForm;

  window.editMaterial = function (id) {
    var materials = window.allMaterialsCache || [];
    var i;
    var form = document.getElementById("mat-form");
    for (i = 0; i < materials.length; i += 1) {
      if (String(materials[i].id) === String(id)) {
        if (!form) return;
        resetMaterialsForm();
        form.style.display = "grid";
        editingMaterial = true;
        initializeMaterialNamePicker(materials[i].id);
        var heading = document.querySelector("#view-materials .panel-heading");
        if (heading && heading.scrollIntoView) heading.scrollIntoView({behavior: "smooth"});
        return;
      }
    }
    showMessage("المادة غير موجودة. حدّث صفحة المواد ثم حاول مرة أخرى.");
  };

  function renderMaterialsTable(rows, noResults) {
    if (!rows.length) {
      return '<p class="empty-table">' + (noResults ? "لا توجد نتائج." : "لم تتم إضافة مواد بعد.") + '</p>';
    }
    return '<div class="table-wrap"><table><thead><tr><th>اسم المادة</th><th>مخزون/وحدة</th><th>شراء</th><th>استخدام</th><th>تكلفة الوحدة</th><th>المخزون</th><th>حد التنبيه</th><th>الإجراءات</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr><td>' + escapeHtml(row.name) + '</td><td>' +
          escapeHtml(row.unit_label || row.unit) +
          (row.unit_needs_review ? ' <span class="unit-review-badge">تحتاج مراجعة</span>' : '') +
          '</td><td>' + escapeHtml(row.purchase_unit_label || row.purchase_unit || row.unit || "—") +
          '</td><td>' + escapeHtml(row.usage_unit_label || row.usage_unit || row.unit || "—") +
          '</td><td dir="ltr">' + formatMoney(row.cost_per_unit) +
          '</td><td dir="ltr">' + row.current_stock + '</td><td dir="ltr">' + row.reorder_level +
          '</td><td class="actions"><button class="button button-secondary small-btn" onclick="editMaterial(' + Number(row.id) + ')">تعديل</button> ' +
          '<button class="button button-danger small-btn" onclick="deleteRecord(\'materials\', ' + Number(row.id) + ', loadMaterialsView)">حذف</button></td></tr>';
      }).join("") + "</tbody></table></div>";
  }

  async function loadMaterialsView() {
    var section = document.getElementById("view-materials");
    disposeMaterialPickers();
    try {
      var rows = await apiCall("/api/admin/materials");
      window.allMaterialsCache = rows;
      var tableHtml = renderMaterialsTable(rows, false);

      section.innerHTML =
        '<article class="panel"><div class="panel-heading"><h2>المواد الخام</h2>' +
        '<div class="inventory-heading-actions">' + renderImportControls("materials") +
        '<input id="materials-search" class="search-box-inventory" type="search" placeholder="ابحث في المواد..." aria-label="البحث في المواد">' +
        '<button type="button" class="button button-primary" onclick="openNewMaterialForm()">+ إضافة مادة</button></div></div>' +
        '<form id="mat-form" class="admin-form" style="display:none;">' +
        '<input type="hidden" id="mt-edit-id">' +
        '<div class="field"><label for="mt-name">اسم المادة</label><div id="mt-name-picker"></div>' +
        '<small id="mt-name-hint" class="material-name-hint"></small></div>' +
        '<div class="field"><label for="mt-unit">الوحدة</label><select id="mt-unit">' +
        '<option value="g">جرام</option><option value="kg">كجم</option><option value="ml">مل</option>' +
        '<option value="L">لتر</option><option value="pcs">قطعة</option></select>' +
        '<small id="mt-unit-hint" class="material-name-hint"></small></div>' +
        '<div class="field"><label for="mt-cost">تكلفة الوحدة</label><input type="number" step="0.01" min="0" id="mt-cost"></div>' +
        '<div class="field"><label for="mt-stock">المخزون الحالي</label><input type="number" step="0.01" min="0" id="mt-stock"></div>' +
        '<div class="field"><label for="mt-purchase-unit">وحدة الشراء</label><select id="mt-purchase-unit"><option value="g">جرام</option><option value="kg">كجم</option><option value="ml">مل</option><option value="L">لتر</option><option value="pcs">قطعة</option></select></div>' +
        '<div class="field"><label for="mt-usage-unit">وحدة الاستخدام / الوصفة</label><select id="mt-usage-unit"><option value="g">جرام</option><option value="kg">كجم</option><option value="ml">مل</option><option value="L">لتر</option><option value="pcs">قطعة</option></select></div>' +
        '<div class="field"><label for="mt-reorder">حد تنبيه انخفاض المخزون</label><input type="number" step="0.001" min="0" id="mt-reorder" value="500"><small id="mt-reorder-hint" class="material-name-hint"></small></div>' +
        '<div class="form-actions"><button type="submit" class="button button-primary" id="mt-submit-btn">حفظ المادة</button>' +
        '<button type="button" class="button button-secondary" id="mt-cancel">إلغاء</button></div></form>' +
        '<div id="materials-table-content">' + tableHtml + '</div></article>';

      bindInventorySearch(
        "materials-search", "materials-table-content", rows,
        function (row) { return [row.name, row.unit_label || row.unit].join(" "); },
        renderMaterialsTable
      );
      document.getElementById("mat-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        var editId = document.getElementById("mt-edit-id").value;
        var nameInput = document.getElementById("mt-name");
        var exactName = (window.allMaterialsCache || []).filter(function (item) {
          return item.name.toLowerCase() === nameInput.value.replace(/^\s+|\s+$/g, "").toLowerCase();
        })[0];
        if (!editId && exactName) {
          showMessage("هذه المادة موجودة بالفعل. اخترها من الاقتراحات لتحديثها.");
          return;
        }
        var payload = {
          name: nameInput.value.replace(/^\s+|\s+$/g, ""),
          unit: document.getElementById("mt-unit").value,
          cost_per_unit: document.getElementById("mt-cost").value || 0,
          current_stock: document.getElementById("mt-stock").value || 0,
          reorder_level: document.getElementById("mt-reorder").value || 5,
          purchase_unit: document.getElementById("mt-purchase-unit").value,
          usage_unit: document.getElementById("mt-usage-unit").value
        };
        try {
          await apiCall("/api/admin/materials" + (editId ? "/" + editId : ""), {
            method: editId ? "PUT" : "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
          });
          showMessage(editId ? "تم تحديث المادة." : "تم حفظ المادة.", true);
          this.style.display = "none";
          resetMaterialsForm();
          await loadMaterialsView();
        } catch (error) {
          showMessage(error.message);
        }
      });
      document.getElementById("mt-cancel").addEventListener("click", function () {
        resetMaterialsForm();
        document.getElementById("mat-form").style.display = "none";
      });
      bindImportControls("materials");
    } catch (error) {
      section.innerHTML = '<p>حدث خطأ: ' + escapeHtml(error.message) + '</p>';
    }
  }
  window.loadMaterialsView = loadMaterialsView;

  function renderRetailTable(rows, noResults) {
    if (!rows.length) {
      return '<p class="empty-table">' + (noResults ? "لا توجد نتائج." : "لا توجد منتجات جاهزة مسجلة بعد.") + '</p>';
    }
    return '<div class="table-wrap"><table><thead><tr><th>الاسم</th><th>التصنيف</th><th>التكلفة</th><th>السعر</th><th>الكمية</th><th>الوحدة</th><th>الإجراءات</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr><td>' + escapeHtml(row.name) +
          '</td><td>' + escapeHtml(row.category_label || categoryLabel(row.category)) +
          '</td><td dir="ltr">' + formatMoney(row.cost_price) + '</td><td dir="ltr">' +
          formatMoney(row.sell_price) + '</td><td dir="ltr">' + row.stock_quantity +
          '</td><td>' + escapeHtml(row.unit || "قطعة") + '</td><td class="actions">' +
          '<button class="button button-secondary small-btn" onclick="editRetail(' + Number(row.id) + ')">تعديل</button> ' +
          '<button class="button button-danger small-btn" onclick="deleteRecord(\'retail\', ' + Number(row.id) + ', loadRetailView)">حذف</button></td></tr>';
      }).join("") + "</tbody></table></div>";
  }

  function resetRetailForm() {
    var form = document.getElementById("retail-form");
    if (!form) return;
    form.reset();
    document.getElementById("ret-edit-id").value = "";
    var unitSelect = document.getElementById("ret-unit");
    if (unitSelect) unitSelect.value = "قطعة";
    var stockInput = document.getElementById("ret-stock");
    if (stockInput) stockInput.step = "1";
    document.getElementById("ret-submit-btn").textContent = "حفظ المنتج";
  }

  function openNewRetailForm() {
    var form = document.getElementById("retail-form");
    if (!form) return;
    resetRetailForm();
    form.style.display = "grid";
  }
  window.openNewRetailForm = openNewRetailForm;

  window.editRetail = function (id) {
    apiCall("/api/admin/retail").then(function (rows) {
      var item = rows.filter(function (row) { return String(row.id) === String(id); })[0];
      var form = document.getElementById("retail-form");
      var categorySelect;
      if (!item || !form) {
        showMessage("المنتج الجاهز غير موجود.");
        return;
      }
      resetRetailForm();
      document.getElementById("ret-edit-id").value = item.id;
      document.getElementById("ret-name").value = item.name || "";
      document.getElementById("ret-cost").value = item.cost_price;
      document.getElementById("ret-price").value = item.sell_price;
      document.getElementById("ret-stock").value = item.stock_quantity;
      var unitSelect = document.getElementById("ret-unit");
      if (unitSelect) {
        unitSelect.value = item.unit || "قطعة";
        document.getElementById("ret-stock").step = (item.unit === "قطعة" || !item.unit) ? "1" : "0.001";
      }
      categorySelect = document.getElementById("ret-category");
      categorySelect.value = item.category;
      document.getElementById("ret-submit-btn").textContent = "تحديث المنتج";
      form.style.display = "grid";
    }).catch(function (error) { showMessage(error.message); });
  };

  async function loadRetailView() {
    var section = document.getElementById("view-retail");
    if (!section) return;
    try {
      var rows = await apiCall("/api/admin/retail");
      await loadCategoriesCache();
      section.innerHTML =
        '<article class="panel"><div class="panel-heading"><h2>المنتجات الجاهزة</h2>' +
        '<div class="inventory-heading-actions">' + renderImportControls("retail") +
        '<input id="retail-search" class="search-box-inventory" type="search" placeholder="ابحث في المنتجات الجاهزة..." aria-label="البحث في المنتجات الجاهزة">' +
        '<button type="button" class="button button-primary" onclick="openNewRetailForm()">+ إضافة منتج</button></div></div>' +
        '<form id="retail-form" class="admin-form" style="display:none;">' +
        '<input type="hidden" id="ret-edit-id">' +
        '<div class="field"><label for="ret-name">الاسم</label><input id="ret-name" type="text"></div>' +
        '<div class="field"><label for="ret-category">التصنيف</label><div class="cat-select-row"><select id="ret-category">' +
        renderCategoryOptions("retail") + '</select><button type="button" id="ret-new-category-toggle" class="button button-secondary cat-add-button">➕ تصنيف</button></div>' +
        '<div id="ret-new-category" class="cat-inline-create" hidden><input id="ret-new-category-label" type="text" maxlength="80" placeholder="اسم التصنيف الجديد">' +
        '<button type="button" id="ret-new-category-submit" class="button button-primary small-btn">إضافة</button></div></div>' +
        '<div class="field"><label for="ret-cost">سعر التكلفة</label><input id="ret-cost" type="number" min="0" step="0.01"></div>' +
        '<div class="field"><label for="ret-price">سعر البيع</label><input id="ret-price" type="number" min="0" step="0.01"></div>' +
        '<div class="field"><label for="ret-stock">الكمية</label><input id="ret-stock" type="number" min="0" step="1"></div>' +
        '<div class="field"><label for="ret-unit">الوحدة</label><select id="ret-unit">' +
        '<option value="قطعة">قطعة</option><option value="جرام">جرام</option><option value="كجم">كجم</option>' +
        '<option value="مل">مل</option><option value="لتر">لتر</option></select></div>' +
        '<div class="form-actions"><button type="submit" id="ret-submit-btn" class="button button-primary">حفظ المنتج</button>' +
        '<button type="button" id="ret-cancel" class="button button-secondary">إلغاء</button></div></form>' +
        '<div id="retail-table-content">' + renderRetailTable(rows, false) + '</div></article>';

      var unitEl = document.getElementById("ret-unit");
      var stockEl = document.getElementById("ret-stock");
      if (unitEl && stockEl) {
        unitEl.addEventListener("change", function () {
          stockEl.step = unitEl.value === "قطعة" ? "1" : "0.001";
        });
      }

      bindInventorySearch(
        "retail-search", "retail-table-content", rows,
        function (row) { return [row.name, row.category_label || categoryLabel(row.category)].join(" "); },
        renderRetailTable
      );
      bindInlineCategoryCreator("retail", "ret");
      document.getElementById("retail-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        var editId = document.getElementById("ret-edit-id").value;
        var payload = {
          name: document.getElementById("ret-name").value,
          category: document.getElementById("ret-category").value,
          cost_price: document.getElementById("ret-cost").value || 0,
          sell_price: document.getElementById("ret-price").value || 0,
          stock_quantity: document.getElementById("ret-stock").value || 0,
          unit: document.getElementById("ret-unit") ? document.getElementById("ret-unit").value : "قطعة"
        };
        try {
          await apiCall("/api/admin/retail" + (editId ? "/" + editId : ""), {
            method: editId ? "PUT" : "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
          });
          showMessage(editId ? "تم تحديث المنتج الجاهز." : "تم حفظ المنتج الجاهز.", true);
          this.style.display = "none";
          resetRetailForm();
          await loadRetailView();
        } catch (error) { showMessage(error.message); }
      });
      document.getElementById("ret-cancel").addEventListener("click", function () {
        resetRetailForm();
        document.getElementById("retail-form").style.display = "none";
      });
      bindImportControls("retail");
    } catch (error) {
      section.innerHTML = '<p>حدث خطأ: ' + escapeHtml(error.message) + '</p>';
    }
  }
  window.loadRetailView = loadRetailView;

  function categoryScopeLabel(scope) {
    return {drink: "مشروبات", retail: "منتجات جاهزة", book: "كتب"}[scope] || scope;
  }

  function categoryForId(id) {
    return allCategoriesCache.filter(function (category) {
      return String(category.id) === String(id);
    })[0] || null;
  }

  function renderCategoryGroups(query) {
    var scopes = [
      {key: "drink", title: "☕ تصنيفات المشروبات", pill: "مشروبات"},
      {key: "retail", title: "🛒 تصنيفات المنتجات الجاهزة", pill: "جاهزة"},
      {key: "book", title: "📖 تصنيفات الكتب", pill: "كتب"}
    ];
    var html = "";
    var normalizedQuery = normalizeSearchText(query);
    var i;
    var group;
    var rows;
    var allRows;
    var index;
    var category;
    var disabledUp;
    var disabledDown;
    for (i = 0; i < scopes.length; i += 1) {
      group = scopes[i];
      allRows = allCategoriesCache.filter(function (item) {
        return (item.product_scope || item.scope) === group.key;
      }).sort(function (left, right) {
        return Number(left.sort_order) - Number(right.sort_order) || Number(left.id) - Number(right.id);
      });
      if (group.key === "book" && !allRows.length) continue;
      rows = allRows.filter(function (item) {
        return !normalizedQuery || normalizeSearchText(item.label_ar).indexOf(normalizedQuery) >= 0;
      });
      html += '<section class="cat-group" data-scope="' + group.key + '"><header class="cat-group-header">' +
        '<h3>' + group.title + '</h3><span>' + rows.length + '</span></header>';
      if (!allRows.length) {
        html += '<p class="cat-group-empty">لا توجد تصنيفات هنا — أضِف تصنيفًا جديدًا</p>';
      } else if (!rows.length) {
        html += '<p class="cat-group-empty">لا توجد نتائج</p>';
      } else {
        html += '<div class="cat-card-list">';
        for (index = 0; index < rows.length; index += 1) {
          category = rows[index];
          var fullIndex = allRows.indexOf(category);
          disabledUp = fullIndex === 0;
          disabledDown = fullIndex === allRows.length - 1;
          html += '<article class="cat-card' + (category.is_active ? "" : " is-inactive") +
            '" data-category-id="' + Number(category.id) + '"><div class="cat-card-identity">' +
            '<strong class="cat-card-name">' + escapeHtml(category.label_ar) + '</strong>' +
            '<span class="cat-pill cat-pill-' + group.key + '">' + group.pill + '</span>' +
            '<span class="cat-count' + (Number(category.product_count || 0) ? "" : " is-empty") + '">' +
            '· ' + (Number(category.product_count || 0) ? Number(category.product_count) + ' منتج' : "فاضي") +
            '</span></div><div class="cat-card-controls"><label class="cat-toggle">' +
            '<input type="checkbox" class="cat-active-toggle" data-id="' + Number(category.id) + '"' +
            (category.is_active ? " checked" : "") + '><span class="cat-toggle-track"></span>' +
            '<span class="cat-toggle-label">' + (category.is_active ? "نشط" : "معطّل") +
            '</span></label><div class="cat-card-actions"><span class="cat-reorder" role="group" aria-label="ترتيب التصنيف">' +
            '<button type="button" class="cat-reorder-btn" data-action="move-up" data-id="' + Number(category.id) +
            '" aria-label="نقل لأعلى" title="نقل لأعلى"' + (disabledUp ? " disabled" : "") +
            '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg></button>' +
            '<button type="button" class="cat-reorder-btn" data-action="move-down" data-id="' + Number(category.id) +
            '" aria-label="نقل لأسفل" title="نقل لأسفل"' + (disabledDown ? " disabled" : "") +
            '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button></span>' +
            '<button type="button" class="cat-icon-button" data-action="edit" data-id="' + Number(category.id) +
            '" aria-label="تعديل الاسم" title="تعديل الاسم">✏️</button>' +
            '<button type="button" class="cat-icon-button cat-icon-danger" data-action="delete" data-id="' +
            Number(category.id) + '" aria-label="حذف" title="حذف">🗑️</button></div></div></article>';
        }
        html += '</div>';
      }
      html += '</section>';
    }
    return html || '<p class="cat-group-empty">لا توجد تصنيفات مسجلة بعد.</p>';
  }

  function renderCategoryList() {
    var list = document.getElementById("categories-list");
    var search = document.getElementById("categories-search");
    if (list) list.innerHTML = renderCategoryGroups(search ? search.value : "");
  }

  function setCategoryForm(category) {
    var form = document.getElementById("category-form");
    if (!form) return;
    form.reset();
    document.getElementById("cat-edit-id").value = category ? category.id : "";
    document.getElementById("cat-label").value = category ? category.label_ar : "";
    document.getElementById("cat-scope").value = category ? category.scope : "drink";
    document.getElementById("cat-sort-order").value = category ? category.sort_order : 100;
    document.getElementById("cat-active").checked = category ? category.is_active : true;
    document.getElementById("cat-slug-value").value = category ? category.slug : "";
    document.getElementById("cat-submit").textContent = category ? "تحديث التصنيف" : "حفظ التصنيف";
    form.style.display = "grid";
  }

  async function loadCategoriesView() {
    var section = document.getElementById("view-categories");
    if (!section) return;
    try {
      await loadCategoriesCache();
      section.innerHTML =
        '<article class="panel"><div class="cat-toolbar"><div><h2>إدارة التصنيفات</h2>' +
        '<p class="muted small">نظّم تصنيفات المشروبات والمنتجات الجاهزة والكتب.</p></div>' +
        '<div class="cat-toolbar-actions"><input id="categories-search" class="search-box-inventory" type="search" placeholder="ابحث بالاسم..." aria-label="البحث باسم التصنيف">' +
        '<a class="button button-secondary" href="/api/admin/export/categories">تصدير البيانات</a>' +
        '<button type="button" class="button button-primary" id="cat-add">+ إضافة تصنيف</button></div></div>' +
        '<form id="category-form" class="admin-form cat-form" style="display:none;"><input type="hidden" id="cat-edit-id"><input type="hidden" id="cat-slug-value">' +
        '<div class="field"><label for="cat-label">اسم التصنيف *</label><input id="cat-label" type="text" maxlength="80" required></div>' +
        '<div class="field"><label for="cat-scope">نوع المنتج *</label><select id="cat-scope"><option value="drink">مشروبات</option>' +
        '<option value="retail">منتجات جاهزة</option><option value="book">كتب (محجوز للمستقبل)</option></select></div>' +
        '<div class="field"><label for="cat-sort-order">الترتيب</label><input id="cat-sort-order" type="number" step="1" value="100"></div>' +
        '<label class="cat-toggle cat-form-active"><span class="cat-toggle-label">نشط</span><input id="cat-active" type="checkbox" checked><span class="cat-toggle-track" aria-hidden="true"></span></label>' +
        '<div class="form-actions"><button type="submit" id="cat-submit" class="button button-primary">حفظ التصنيف</button>' +
        '<button type="button" id="cat-cancel" class="button button-secondary">إلغاء</button></div></form>' +
        '<div id="categories-list" class="cat-groups">' + renderCategoryGroups("") + '</div>' +
        '<div id="cat-delete-modal" class="cat-modal" hidden></div></article>';
      var searchTimer = null;
      document.getElementById("categories-search").addEventListener("input", function () {
        var input = this;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          if (document.getElementById("categories-list")) renderCategoryList();
        }, 200);
      });
      document.getElementById("cat-add").addEventListener("click", function () {
        setCategoryForm(null);
      });
      document.getElementById("cat-cancel").addEventListener("click", function () {
        document.getElementById("category-form").style.display = "none";
      });
      document.getElementById("category-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        var editId = document.getElementById("cat-edit-id").value;
        var payload = {
          label_ar: document.getElementById("cat-label").value,
          scope: document.getElementById("cat-scope").value,
          sort_order: Number(document.getElementById("cat-sort-order").value),
          is_active: document.getElementById("cat-active").checked
        };
        try {
          await apiCall("/api/categories" + (editId ? "/" + editId : ""), {
            method: editId ? "PUT" : "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
          });
          showMessage(editId ? "تم تحديث التصنيف." : "تمت إضافة التصنيف.", true);
          await loadCategoriesView();
        } catch (error) {
          showMessage("تعذر حفظ التصنيف: " + error.message);
        }
      });
      document.getElementById("categories-list").addEventListener("change", async function (event) {
        var toggle = event.target;
        if (!toggle.classList.contains("cat-active-toggle")) return;
        var category = categoryForId(toggle.getAttribute("data-id"));
        if (!category) return;
        toggle.disabled = true;
        try {
          await updateCategoryActive(category, toggle.checked);
          category.is_active = toggle.checked;
          showMessage(toggle.checked ? "تم تفعيل التصنيف." : "تم تعطيل التصنيف.", true);
          renderCategoryList();
        } catch (error) {
          toggle.checked = !toggle.checked;
          toggle.disabled = false;
          showMessage("تعذر تغيير حالة التصنيف: " + error.message);
        }
      });
      document.getElementById("categories-list").addEventListener("click", function (event) {
        var button = event.target.closest ? event.target.closest("[data-action]") : event.target;
        var category;
        if (!button || !button.getAttribute("data-action")) return;
        category = categoryForId(button.getAttribute("data-id"));
        if (!category || button.disabled) return;
        if (button.getAttribute("data-action") === "edit") {
          setCategoryForm(category);
        } else if (button.getAttribute("data-action") === "delete") {
          window.deleteCategory(category);
        } else if (button.getAttribute("data-action") === "move-up") {
          window.moveCategory(category, "up");
        } else if (button.getAttribute("data-action") === "move-down") {
          window.moveCategory(category, "down");
        }
      });
    } catch (error) {
      section.innerHTML = '<p class="empty-table">تعذر تحميل التصنيفات: ' + escapeHtml(error.message) + '</p>';
    }
  }

  window.editCategory = function (id) {
    var category = categoryForId(id);
    if (!category) {
      showMessage("التصنيف غير موجود. حدّث الصفحة ثم حاول مرة أخرى.");
      return;
    }
    setCategoryForm(category);
  };

  async function updateCategoryActive(category, isActive) {
    await apiCall("/api/categories/" + category.id, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        label_ar: category.label_ar,
        scope: category.scope,
        sort_order: category.sort_order,
        is_active: isActive
      })
    });
  }

  function closeCategoryDeleteModal() {
    var modal = document.getElementById("cat-delete-modal");
    if (modal) {
      modal.hidden = true;
      modal.innerHTML = "";
    }
  }

  async function deactivateCategory(category) {
    try {
      await updateCategoryActive(category, false);
      category.is_active = false;
      closeCategoryDeleteModal();
      showMessage("تم تعطيل التصنيف.", true);
      renderCategoryList();
      return true;
    } catch (error) {
      showMessage("تعذر تعطيل التصنيف: " + error.message);
      return false;
    }
  }

  async function confirmCategoryDelete(category, targetSlug) {
    var count = Number(category.product_count || 0);
    var url = "/api/categories/" + category.id;
    if (count) {
      var productScope = category.product_scope || category.scope;
      var target = allCategoriesCache.filter(function (item) {
        return item.slug === targetSlug && item.scope === productScope &&
          item.is_active && String(item.id) !== String(category.id);
      })[0];
      if (!target) {
        showMessage("اختر تصنيفًا نشطًا آخر من نفس نوع المنتج.");
        return;
      }
      url += "?reassign_to=" + encodeURIComponent(target.slug);
    }
    try {
      await apiCall(url, {method: "DELETE"});
      showMessage("تم حذف التصنيف ونقل المنتجات المرتبطة به إن وجدت.", true);
      closeCategoryDeleteModal();
      await loadCategoriesView();
      return true;
    } catch (error) {
      showMessage("تعذر حذف التصنيف: " + error.message);
      return false;
    }
  }

  window.deleteCategory = function (categoryOrId) {
    var category = typeof categoryOrId === "object"
      ? categoryOrId : categoryForId(categoryOrId);
    var modal = document.getElementById("cat-delete-modal");
    var targetCategories;
    var targetOptions;
    var count;
    if (!category) {
      showMessage("التصنيف غير موجود. حدّث الصفحة ثم حاول مرة أخرى.");
      return;
    }
    count = Number(category.product_count || 0);
    if (!count) {
      if (!window.confirm("حذف التصنيف «" + category.label_ar + "»؟")) return;
      confirmCategoryDelete(category, "");
      return;
    }
    if (!modal) return;
    targetCategories = category.product_count && !category.product_scope
      ? []
      : allCategoriesCache.filter(function (item) {
          return item.scope === (category.product_scope || category.scope) && item.is_active &&
            String(item.id) !== String(category.id);
        });
    targetOptions = '<option value="">اختر تصنيفًا بديلًا</option>' +
      targetCategories.map(function (item) {
        return '<option value="' + escapeHtml(item.slug) + '">' + escapeHtml(item.label_ar) + '</option>';
      }).join("");
    modal.innerHTML =
      '<div class="cat-modal-backdrop" data-action="modal-close"><section class="cat-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="cat-modal-title">' +
      '<button type="button" class="cat-modal-close" data-action="modal-cancel" aria-label="إغلاق">×</button>' +
      '<h3 id="cat-modal-title">التصنيف «' + escapeHtml(category.label_ar) + '» عليه ' + count + ' منتج</h3>' +
      '<p>لا يمكن حذف تصنيف مرتبط بمنتجات. انقل المنتجات إلى تصنيف آخر من نفس نوع المنتج، أو عطّل التصنيف بدلاً من حذفه.</p>' +
      (targetCategories.length
        ? '<label for="cat-modal-target">التصنيف البديل</label><select id="cat-modal-target">' + targetOptions + '</select>'
        : '<p class="cat-modal-warning">' +
          (category.product_count && !category.product_scope
            ? "التصنيف يحتوي أصنافًا من أكثر من نوع؛ عطّل التصنيف حتى لا تفقد ارتباطاتها."
            : "لا يوجد تصنيف نشط آخر من نفس نوع المنتج. أضف تصنيفًا أو عطّل هذا التصنيف.") +
          '</p>') +
      '<div class="cat-modal-actions"><button type="button" class="button button-danger" data-action="modal-delete"' +
      (!targetCategories.length ? " disabled" : "") + '>نقل وحذف</button>' +
      '<button type="button" class="button button-secondary" data-action="modal-deactivate">عطّل فقط</button>' +
      '<button type="button" class="button button-secondary" data-action="modal-cancel">إلغاء</button></div></section></div>';
    modal.hidden = false;
    modal.addEventListener("click", async function handler(event) {
      var action = event.target.getAttribute("data-action");
      if (action === "modal-close" || action === "modal-cancel") {
        closeCategoryDeleteModal();
        modal.removeEventListener("click", handler);
      } else if (action === "modal-deactivate") {
        if (await deactivateCategory(category)) {
          modal.removeEventListener("click", handler);
        }
      } else if (action === "modal-delete") {
        var select = document.getElementById("cat-modal-target");
        if (!select || !select.value) {
          showMessage("اختر تصنيفًا بديلًا نشطًا من نفس نوع المنتج.");
          return;
        }
        if (await confirmCategoryDelete(category, select.value)) {
          modal.removeEventListener("click", handler);
        }
      }
    });
  };

  window.moveCategory = async function (categoryOrId, direction) {
    var category = typeof categoryOrId === "object"
      ? categoryOrId : categoryForId(categoryOrId);
    var group;
    var index;
    var neighbor;
    var oldOrder;
    var oldNeighborOrder;
    if (!category) return;
    group = allCategoriesCache.filter(function (item) {
      return item.scope === category.scope;
    }).sort(function (left, right) {
      return Number(left.sort_order) - Number(right.sort_order) || Number(left.id) - Number(right.id);
    });
    index = group.indexOf(category);
    neighbor = group[index + (direction === "up" ? -1 : 1)];
    if (!neighbor) return;
    oldOrder = category.sort_order;
    oldNeighborOrder = neighbor.sort_order;
    category.sort_order = oldNeighborOrder;
    neighbor.sort_order = oldOrder;
    renderCategoryList();
    try {
      await apiCall("/api/categories/" + category.id + "/move", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({direction: direction})
      });
      await loadCategoriesCache();
      renderCategoryList();
    } catch (error) {
      category.sort_order = oldOrder;
      neighbor.sort_order = oldNeighborOrder;
      renderCategoryList();
      showMessage("تعذر نقل التصنيف: " + error.message);
    }
  };

  // ==========================================
  // COMMON UI HELPERS
  // ==========================================
  window.toggleForm = function(formId) {
    var form = document.getElementById(formId);
    if(form) {
        form.reset();
        form.style.display = form.style.display === 'grid' ? 'none' : 'grid';
    }
  };

  window.deleteRecord = async function(resource, id, refreshCallback) {
    var normalizedId = Number(id);
    var successMessages = {
      books: "تم حذف الكتاب",
      drinks: "تم حذف المشروب",
      materials: "تم حذف المادة",
      retail: "تم حذف المنتج الجاهز"
    };
    if (!isFinite(normalizedId) || normalizedId < 1) {
      showMessage("معرّف السجل غير صالح.");
      return;
    }
    if (!confirm("هل أنت متأكد من حذف هذا السجل؟")) return;
    try {
      await apiCall(`/api/admin/${resource}/${normalizedId}`, { method: "DELETE" });
      showMessage(successMessages[resource] || "تم حذف السجل.", true);
      if (refreshCallback) await refreshCallback();
    } catch(err) {
      showMessage(err.message);
    }
  };

  // ==========================================
  // REPORTS & SETTINGS
  // ==========================================
  async function renderReports() {
    var section = document.getElementById("view-reports");
    section.innerHTML = `
      <article class="panel">
        <div class="panel-heading"><h2>التقرير الشهري</h2></div>
        <div class="admin-form">
          <div class="field"><label>اختر الشهر</label><input type="month" id="rep-month" value="${currentMonthValue()}"></div>
          <div class="field form-actions"><button class="button button-primary" onclick="loadReportData()">عرض التقرير</button></div>
        </div>
        <div id="report-output"></div>
      </article>
    `;
  }

  window.loadReportData = async function() {
    var month = document.getElementById("rep-month").value;
    try {
      var res = await apiCall(`/api/admin/reports?month=${month}`);
      document.getElementById("report-output").innerHTML = `
        <div class="metric-grid">
          <div class="metric-card"><span>الإيرادات</span><strong dir="ltr">${formatMoney(res.revenue)}</strong></div>
          <div class="metric-card"><span>تكلفة البضاعة المباعة</span><strong dir="ltr">${formatMoney(res.cogs)}</strong></div>
          <div class="metric-card"><span>المصروفات</span><strong dir="ltr">${formatMoney(res.expenses)}</strong></div>
          <div class="metric-card"><span>صافي الربح</span><strong dir="ltr" class="${res.profit >= 0 ? 'text-positive' : 'text-negative'}">${formatMoney(res.profit)}</strong></div>
        </div>
        <p class="muted mt-2">${res.orders} عملية بيع.</p>
      `;
    } catch(e) { alert(e.message); }
  };

  // Every wording the receipt prints, so the shop can rename any line.
  var RECEIPT_TEXT_FIELDS = [
    ["receipt_tagline", "سطر الوصف تحت اسم المتجر"],
    ["receipt_invoice_label", "كلمة الفاتورة (مثل: فاتورة)"],
    ["receipt_cashier_label", "كلمة الكاشير"],
    ["receipt_items_header", "عنوان عمود الأصناف"],
    ["receipt_items_count_label", "عدد الأصناف"],
    ["receipt_subtotal_label", "المجموع الفرعي"],
    ["receipt_discount_label", "الخصم"],
    ["receipt_total_label", "الإجمالي"],
    ["receipt_payment_label", "طريقة الدفع"],
    ["receipt_paid_label", "المدفوع"],
    ["receipt_change_label", "الباقي"],
    ["receipt_currency", "العملة (مثل: ج.م)"],
    ["receipt_thanks", "رسالة الشكر"],
    ["receipt_contact_label", "كلمة للاستفسار"],
    ["receipt_phone", "رقم الهاتف"],
    ["receipt_email", "البريد أو حساب المتجر"],
    ["receipt_policy", "سطر سياسة الاستبدال"]
  ];
  var RECEIPT_QR_MODE_LABELS = {
    none: "بدون كيو ار كود",
    text: "نص حر",
    url: "رابط موقع",
    phone: "اتصال بالهاتف",
    whatsapp: "محادثة واتساب",
    email: "بريد إلكتروني"
  };

  function receiptFieldHtml(key, caption, receipt) {
    return '<div class="field"><label for="' + key + '">' + caption + '</label>' +
      '<input type="text" id="' + key + '" maxlength="120" value="' +
      escapeHtml(receipt[key] || "") + '"></div>';
  }

  async function renderSettings() {
    var section = document.getElementById("view-settings");
    try {
      // 1. Fetch current settings
      var data = await apiCall("/api/admin/settings");
      var receipt = data.receipt || {};

      // 2. Build HTML with BOTH Shop Settings AND Password Change forms
      section.innerHTML = `
        <article class="panel">
          <div class="panel-heading"><h2>بيانات المتجر</h2></div>
          <form id="set-form" class="admin-form">
            <div class="field field-wide">
              <label for="st-name">اسم المتجر</label>
              <input type="text" id="st-name" value="${escapeHtml(data.shop_name)}">
            </div>
            <div class="field field-wide">
              <label for="st-addr">العنوان / رقم الهاتف</label>
              <textarea id="st-addr" placeholder="مثال: شارع ...، القاهرة | هاتف: 01...">${escapeHtml(data.shop_address)}</textarea>
            </div>
            <div class="field">
              <label for="st-shift-hours">ساعات الوردية القياسية</label>
              <input id="st-shift-hours" type="number" min="1" max="24" step="0.5" value="${escapeHtml(data.shift_hours)}">
            </div>
            <div class="form-actions">
              <button type="submit" class="button button-primary">حفظ بيانات المتجر</button>
            </div>
          </form>
        </article>

        <article class="panel">
          <div class="panel-heading"><h2>الفاتورة والشعار</h2></div>
          <p class="muted small settings-help">كل كلمة في الفاتورة قابلة للتعديل، والشعار يظهر فوق اسم المتجر. المعاينة على اليسار تطابق الورق تمامًا.</p>
          <div class="receipt-logo-row">
            <img id="logo-preview" class="receipt-logo-preview" src="/branding/logo" alt="الشعار الحالي">
            <div class="receipt-logo-tools">
              <input id="logo-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
              <div class="inventory-heading-actions">
                <button type="button" class="button button-primary" id="logo-upload-button">رفع الشعار</button>
                <button type="button" class="button button-secondary" id="logo-delete-button">استرجاع الشعار الأصلي</button>
              </div>
              <p id="logo-state" class="muted small">${data.logo_uploaded ? "يتم الآن استخدام الصورة التي رفعتها." : (data.logo_available ? "يتم الآن استخدام الشعار الأصلي للبرنامج." : "لا توجد صورة شعار حالية.")}</p>
            </div>
            <iframe id="receipt-preview-frame" class="receipt-preview-frame" src="/api/receipt-preview" title="معاينة الفاتورة"></iframe>
          </div>
          <div id="receipt-form" class="admin-form">
            <div class="field">
              <label for="receipt_paper_width">عرض الورق</label>
              <select id="receipt_paper_width">
                ${["58", "72", "80"].map(function (width) {
                  return '<option value="' + width + '"' + (String(receipt.receipt_paper_width) === width ? " selected" : "") + ">" + width + " مم</option>";
                }).join("")}
              </select>
            </div>
            <div class="field">
              <label for="receipt_qr_mode">الكيو ار كود أسفل الفاتورة</label>
              <select id="receipt_qr_mode">
                ${Object.keys(RECEIPT_QR_MODE_LABELS).map(function (mode) {
                  return '<option value="' + mode + '"' + (receipt.receipt_qr_mode === mode ? " selected" : "") + '">' + RECEIPT_QR_MODE_LABELS[mode] + '</option>';
                }).join("")}
              </select>
            </div>
            <div class="field field-wide">
              <label for="receipt_qr_value">نص أو رابط الكيو ار كود</label>
              <input type="text" id="receipt_qr_value" maxlength="120" value="${escapeHtml(receipt.receipt_qr_value || "")}" placeholder="اتركه فارغًا ليُستخدم رقم الهاتف أو البريد بالأعلى">
            </div>
            <div class="field">
              <label for="receipt_show_logo">إظهار الشعار</label>
              <label class="checkbox-line"><input type="checkbox" id="receipt_show_logo" ${String(receipt.receipt_show_logo) === "1" ? "checked" : ""}> الشعار فوق اسم المتجر</label>
            </div>
            <div class="field">
              <label for="receipt_auto_print">الطباعة التلقائية</label>
              <label class="checkbox-line"><input type="checkbox" id="receipt_auto_print" ${String(receipt.receipt_auto_print) === "1" ? "checked" : ""}> طباعة فورًا بعد البيع (بدون معاينة)</label>
            </div>
            ${RECEIPT_TEXT_FIELDS.map(function (field) {
              return receiptFieldHtml(field[0], field[1], receipt);
            }).join("")}
            <div class="form-actions field-wide">
              <button type="button" class="button button-primary" id="receipt-save-button">حفظ إعدادات الفاتورة</button>
              <button type="button" class="button button-secondary" id="receipt-refresh-preview">تحديث المعاينة</button>
            </div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-heading"><h2>الأمان</h2></div>
          <p class="muted small settings-help">يمكنك تغيير كلمة مرور دخول الإدارة هنا.</p>
          <form id="pass-form" class="admin-form">
            <div class="field field-wide">
              <label for="new-pass">كلمة المرور الجديدة (6 أحرف على الأقل)</label>
              <input type="password" id="new-pass" minlength="6" required autocomplete="off">
            </div>
            <div class="field field-wide">
              <label for="conf-pass">تأكيد كلمة المرور الجديدة</label>
              <input type="password" id="conf-pass" minlength="6" required autocomplete="off">
            </div>
            <div class="form-actions">
              <button type="submit" class="button button-danger">تحديث كلمة المرور</button>
            </div>
          </form>
        </article>
      `;

      function shopPayload(extra) {
        // The settings endpoint always rewrites the shop fields, so every save
        // resends them alongside whatever else the form changed.
        return Object.assign({
          shop_name: document.getElementById("st-name").value,
          shop_address: document.getElementById("st-addr").value,
          shift_hours: document.getElementById("st-shift-hours").value
        }, extra || {});
      }

      function refreshReceiptPreview() {
        var frame = document.getElementById("receipt-preview-frame");
        if (frame) frame.src = "/api/receipt-preview?r=" + Date.now();
      }

      var logoUploadButton = document.getElementById("logo-upload-button");
      if (logoUploadButton) {
        logoUploadButton.addEventListener("click", async function () {
          var input = document.getElementById("logo-file");
          if (!input.files || !input.files.length) {
            showMessage("اختر صورة أولًا.");
            return;
          }
          var form = new FormData();
          form.append("logo", input.files[0]);
          logoUploadButton.disabled = true;
          try {
            var result = await apiCall("/api/admin/logo", {method: "POST", body: form});
            document.getElementById("logo-preview").src = result.logo_url;
            document.getElementById("logo-state").textContent = "يتم الآن استخدام الصورة التي رفعتها.";
            input.value = "";
            showMessage("تم رفع الشعار.", true);
            refreshReceiptPreview();
          } catch (error) {
            showMessage(error.message);
          } finally {
            logoUploadButton.disabled = false;
          }
        });
      }

      var logoDeleteButton = document.getElementById("logo-delete-button");
      if (logoDeleteButton) {
        logoDeleteButton.addEventListener("click", async function () {
          if (!window.confirm("استرجاع الشعار الأصلي للبرنامج؟")) return;
          try {
            await apiCall("/api/admin/logo", {method: "DELETE"});
            document.getElementById("logo-preview").src = "/branding/logo?r=" + Date.now();
            document.getElementById("logo-state").textContent = "يتم الآن استخدام الشعار الأصلي للبرنامج.";
            showMessage("تم حذف الشعار المرفوع.", true);
            refreshReceiptPreview();
          } catch (error) {
            showMessage(error.message);
          }
        });
      }

      var receiptSaveButton = document.getElementById("receipt-save-button");
      if (receiptSaveButton) {
        receiptSaveButton.addEventListener("click", async function () {
          var payload = shopPayload({
            receipt: {
              receipt_paper_width: document.getElementById("receipt_paper_width").value,
              receipt_qr_mode: document.getElementById("receipt_qr_mode").value,
              receipt_qr_value: document.getElementById("receipt_qr_value").value,
              receipt_show_logo: document.getElementById("receipt_show_logo").checked ? "1" : "0",
              receipt_auto_print: document.getElementById("receipt_auto_print").checked ? "1" : "0"
            }
          });
          RECEIPT_TEXT_FIELDS.forEach(function (field) {
            var input = document.getElementById(field[0]);
            if (input) payload.receipt[field[0]] = input.value;
          });
          receiptSaveButton.disabled = true;
          try {
            var saved = await apiCall("/api/admin/settings", {
              method: "PUT",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify(payload)
            });
            showMessage("تم حفظ إعدادات الفاتورة.", true);
            refreshReceiptPreview();
            if (saved && saved.receipt) {
              document.getElementById("receipt_paper_width").value = String(saved.receipt.receipt_paper_width);
              document.getElementById("receipt_qr_mode").value = saved.receipt.receipt_qr_mode;
            }
          } catch (error) {
            showMessage(error.message);
          } finally {
            receiptSaveButton.disabled = false;
          }
        });
      }

      var previewRefresh = document.getElementById("receipt-refresh-preview");
      if (previewRefresh) previewRefresh.addEventListener("click", refreshReceiptPreview);
      
      // 3. Bind Save Shop Info Event
      document.getElementById("set-form").addEventListener("submit", async function(e) {
        e.preventDefault();
        try {
          var savedSettings = await apiCall("/api/admin/settings", {
            method: "PUT",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify(shopPayload())
          });
          document.getElementById("st-name").value = savedSettings.shop_name;
          updateShopBrand(savedSettings.shop_name);
          showMessage("تم حفظ بيانات المتجر بنجاح.", true);
          refreshReceiptPreview();
        } catch(err) { 
          showMessage("تعذر حفظ بيانات المتجر: " + err.message);
        }
      });

      // 4. Bind Change Password Event (NO CURRENT PASSWORD REQUIRED)
      document.getElementById("pass-form").addEventListener("submit", async function(e) {
        e.preventDefault();
        
        var newPass = document.getElementById("new-pass").value;
        var confPass = document.getElementById("conf-pass").value;

        // Client-side validation
        if (newPass !== confPass) {
          alert("كلمتا المرور غير متطابقتين.");
          return;
        }
        if (newPass.length < 6) {
          alert("يجب ألا تقل كلمة المرور عن 6 أحرف.");
          return;
        }

        try {
          await apiCall("/api/admin/password", {
            method: "PUT",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({ 
              current_password: "", // Empty as requested
              new_password: newPass 
            })
          });
          
          showMessage("تم تحديث كلمة المرور. يرجى تسجيل الخروج ثم الدخول مرة أخرى.", true);
          this.reset(); // Clear form fields
          
          // Auto logout after 2 seconds
          setTimeout(() => {
            document.querySelector('form[action="/admin/logout"]').submit();
          }, 2000);

        } catch(err) { 
          showMessage("تعذر تحديث كلمة المرور: " + err.message);
        }
      });

    } catch(error) { 
      section.innerHTML = `<p class="empty-table">تعذر تحميل الإعدادات: ${escapeHtml(error.message)}</p>`;
    }
  }

  // ==========================================
  // INITIALIZATION
  // ==========================================
  document.querySelectorAll(".nav-item[data-view]").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  
  document.getElementById("menu-toggle")?.addEventListener("click", () => {
    document.getElementById("sidebar")?.classList.toggle("open");
    document.getElementById("nav-shade")?.classList.toggle("open");
  });
  
  document.getElementById("today-date").textContent = "التاريخ: " + formatLocalDate(new Date());
  bindAdminGlobalSearch();
  switchView(currentView);

  // Batch 2c: end the admin session after 15 minutes without activity. The dashboard
  // is a single page, so moving between admin sub-views keeps the session alive.
  const ADMIN_IDLE_LIMIT_MS = 15 * 60 * 1000;
  let adminIdleTimer = null;
  const resetAdminIdleTimer = () => {
    if (adminIdleTimer) clearTimeout(adminIdleTimer);
    adminIdleTimer = setTimeout(() => {
      const logoutForm = document.querySelector('form[action="/admin/logout"]');
      if (logoutForm) logoutForm.submit();
    }, ADMIN_IDLE_LIMIT_MS);
  };
  ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"].forEach(evt =>
    document.addEventListener(evt, resetAdminIdleTimer, { passive: true })
  );
  resetAdminIdleTimer();

})();