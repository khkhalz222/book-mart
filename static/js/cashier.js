(function () {
  "use strict";

  var products = [];
  var cart = [];
  var reservedStock = {materials: {}, books: {}, retail: {}};
  var currentCategory = "all";
  var grid = document.getElementById("product-grid");
  var cartItemsContainer = document.getElementById("cart-items");
  var searchInput = document.getElementById("product-search");
  var payButton = document.getElementById("pay-button");
  var clearSaleButton = document.getElementById("clear-sale-button");
  var messageDiv = document.getElementById("cart-message");
  var totalAmountSpan = document.getElementById("cart-total");
  var settingsModal = document.getElementById("settings-modal");
  var recentOrdersList = document.getElementById("recent-orders-list");
  var quickSearchInput = document.getElementById("quick-product-search");
  var quickResultsContainer = document.getElementById("quick-search-results");
  var quickSearchTimer = null;
  var messageTimer = null;
  var lastStockFailure = null;
  var activeCategories = [];
  var currentCashierView = "pos";
  var systemSearchTimer = null;
  var historySearchTimer = null;
  var currentEmployeeName = "";
  var cartTotal = 0;
  var receiptAutoPrint = false;
  var intakeLines = [];
  var intakeSuggestions = [];
  var intakePicked = null;
  var intakeSearchTimer = null;
  var expenseStockItem = null;
  var expenseSuggestions = [];
  var expenseSuggestionTimer = null;
  var intakeAmountTouched = false;
  var intakeBound = false;
  var expenseStockBound = false;
  var closingBound = false;

  function applyReturnEmployeeName(name) {
    var employeeInput = document.getElementById("return-employee-name");
    if (!employeeInput) return;
    employeeInput.value = name || "";
    employeeInput.readOnly = true;
    employeeInput.setAttribute("aria-readonly", "true");
  }

  function categoryLabel(slug) {
    var i;
    for (i = 0; i < activeCategories.length; i += 1) {
      if (activeCategories[i].slug === slug) return activeCategories[i].label_ar;
    }
    return "";
  }

  function money(amount) {
    var parts = Number(amount || 0).toFixed(2).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }

  function pad2(value) {
    var text = String(value);
    return text.length < 2 ? "0" + text : text;
  }

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

  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/[&<>"']/g, function (character) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[character];
    });
  }

  function findDataElement(target, attribute, boundary) {
    while (target && target !== boundary) {
      if (target.getAttribute && target.getAttribute(attribute) !== null) return target;
      target = target.parentNode;
    }
    return null;
  }

  function requestJson(url, options, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open((options && options.method) || "GET", url, true);
    xhr.setRequestHeader("Accept", "application/json");
    if (options && options.body) xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch (error) {
        callback(new Error("أعاد الخادم استجابة غير صالحة."));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        var requestError = new Error(data.error || "فشل تنفيذ الطلب.");
        requestError.status = xhr.status;
        requestError.payload = data;
        callback(requestError);
        return;
      }
      callback(null, data);
    };
    xhr.onerror = function () {
      callback(new Error("تعذر الاتصال بالخادم المحلي."));
    };
    xhr.send(options && options.body ? options.body : null);
  }

  function showMessage(text, type) {
    if (!messageDiv) return;
    if (messageTimer) {
      clearTimeout(messageTimer);
      messageTimer = null;
    }
    messageDiv.textContent = text || "";
    messageDiv.className = "form-message " + (type || "");
    if (text && type !== "error") {
      messageTimer = setTimeout(function () {
        if (messageDiv && messageDiv.textContent === text) {
          messageDiv.textContent = "";
          messageDiv.className = "form-message";
        }
      }, 3000);
    }
  }

  function showAttendanceMessage(text, success) {
    var target = document.getElementById("attendance-message");
    if (!target) return;
    target.textContent = text || "";
    target.className = "form-message " + (success ? "success" : "error");
  }

  function loadProducts() {
    requestJson("/api/categories/active", null, function (categoryError, categories) {
      activeCategories = categoryError ? [] : categories;
      requestJson("/api/products", null, function (error, data) {
        if (error) {
          if (window.console) console.error(error);
          showMessage("تعذر تحميل المنتجات: " + error.message, "error");
          return;
        }
        if (categoryError) {
          if (window.console) console.error(categoryError);
          showMessage("تعذر تحميل التصنيفات: " + categoryError.message, "error");
        }
        products = data;
        renderCategoryTabs();
        renderProducts();
      });
    });
  }

  function loadTodaySales() {
    var total = document.getElementById("cashier-today-sales");
    if (!total) return;
    requestJson("/api/cashier/today-sales", null, function (error, data) {
      if (error) {
        if (window.console) console.error(error);
        total.textContent = "—";
        return;
      }
      total.textContent = money(data.today_sales);
    });
  }

  function setCashierView(view) {
    var labels = {pos: "نقطة البيع", pending: "الطلبات المعلقة", projects: "المشاريع اليومية", attendance: "حضور الموظفين", notifications: "الإشعارات", expenses: "المصروفات", intake: "تسجيل البضاعة"};
    var content = document.querySelector(".content-split");
    var categoryTabs = document.getElementById("category-tabs");
    var projectView = document.getElementById("cashier-projects-view");
    var attendanceView = document.getElementById("cashier-attendance-view");
    var notificationsView = document.getElementById("cashier-notifications-view");
    var expensesView = document.getElementById("cashier-expenses-view");
    var intakeView = document.getElementById("cashier-intake-view");
    var buttons = document.querySelectorAll(".sidebar-nav [data-cashier-view]");
    var i;
    currentCashierView = view;
    if (content) content.hidden = view !== "pos";
    if (categoryTabs) categoryTabs.hidden = view !== "pos";
    if (projectView) projectView.hidden = view !== "projects";
    if (attendanceView) attendanceView.hidden = view !== "attendance";
    if (notificationsView) notificationsView.hidden = view !== "notifications";
    if (expensesView) expensesView.hidden = view !== "expenses";
    if (intakeView) intakeView.hidden = view !== "intake";
    for (i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle("active", buttons[i].getAttribute("data-cashier-view") === view);
    }
    var breadcrumb = document.getElementById("cashier-breadcrumb");
    if (breadcrumb) breadcrumb.textContent = "/ " + (labels[view] || labels.pos);
    if (view === "projects") loadProjectDays();
    if (view === "attendance") loadEmployeeState();
    if (view === "notifications") loadCashierNotifications();
    if (view === "expenses") {
      bindCashierExpenseStock();
      bindCashierClosing();
      loadCashierExpenses();
      loadCashierClosing();
    }
    if (view === "intake") loadCashierIntake();
    var pendingView = document.getElementById("cashier-pending-view");
    if (pendingView) pendingView.hidden = view !== "pending";
    if (view === "pending") loadPendingOrders();
  }

  function formatDateOnly(value) {
    if (!value) return "";
    var parts = String(value).split("-");
    if (parts.length !== 3) return String(value);
    return parts[2] + "/" + parts[1] + "/" + parts[0];
  }

  function projectSalesRows(lines) {
    if (!lines || !lines.length) return '<tr><td colspan="4">لا توجد عمليات بيع.</td></tr>';
    return lines.map(function (line) {
      return '<tr><td>#' + escapeHtml(line.order_id) + '</td><td>' +
        escapeHtml(line.timestamp_display || formatDateTime(line.timestamp)) + '</td><td>' +
        escapeHtml(line.item_names || "—") + '</td><td dir="ltr">' + money(line.total_amount) + '</td></tr>';
    }).join("");
  }

  function projectReturnRows(lines) {
    if (!lines || !lines.length) return '<tr><td colspan="5">لا توجد عمليات مسترجعة.</td></tr>';
    return lines.map(function (line) {
      return '<tr><td>#' + escapeHtml(line.order_id) + '</td><td>' +
        escapeHtml(line.timestamp_display || formatDateTime(line.timestamp)) + '</td><td>' +
        escapeHtml(line.item_names || "—") + '</td><td>' + escapeHtml(line.reason || "بدون سبب") +
        '</td><td dir="ltr">' + money(line.total_amount) + '</td></tr>';
    }).join("");
  }

  function projectShiftBlocks(shiftBreakdown) {
    if (!shiftBreakdown || !shiftBreakdown.length) return '<p class="muted">لا توجد ورديات مسجلة لهذا اليوم.</p>';
    return shiftBreakdown.map(function (shift) {
      var range = escapeHtml(shift.started_display || "—") +
        (shift.ended_display ? ' إلى ' + escapeHtml(shift.ended_display) : ' (مفتوحة)');
      return '<div class="project-shift">' +
        '<h4>الكاشير: ' + escapeHtml(shift.username) + ' — ' + range + '</h4>' +
        '<p class="muted">مبيعات: <strong dir="ltr">' + money(shift.sales_total) + '</strong>' +
        ' (' + shift.orders_count + ' عملية) · مرتجعات: <strong dir="ltr">' + money(shift.returns_total) +
        '</strong> (' + shift.returns_count + ')</p>' +
        '<div class="table-wrap"><table><thead><tr><th>رقم العملية</th><th>الوقت والتاريخ</th><th>الأصناف</th><th>الإجمالي</th></tr></thead><tbody>' +
        projectSalesRows(shift.sales) + '</tbody></table></div>' +
        (shift.returns && shift.returns.length ?
          '<div class="table-wrap"><table><thead><tr><th>رقم العملية</th><th>الوقت والتاريخ</th><th>الأصناف</th><th>سبب الاسترجاع</th><th>الإجمالي</th></tr></thead><tbody>' +
          projectReturnRows(shift.returns) + '</tbody></table></div>' : '') +
        '</div>';
    }).join("");
  }

  function renderProjectDetail(report) {
    var detail = document.getElementById("cashier-project-detail");
    if (!detail) return;
    var expenseRows = (report.expense_rows || []).map(function (row) {
      return '<tr><td>' + escapeHtml(row.category) + '</td><td dir="ltr">' + money(row.amount) +
        '</td><td>' + escapeHtml(row.note || "") + '</td></tr>';
    }).join("") || '<tr><td colspan="3">لا توجد مصروفات.</td></tr>';
    var purchaseRows = (report.purchases || []).map(function (row) {
      return '<tr><td>' + escapeHtml(formatDateTime(row.timestamp)) + '</td><td>' +
        escapeHtml(row.supplier || "") + '</td><td>' + escapeHtml(row.category || "") +
        '</td><td dir="ltr">' + money(row.amount) + '</td></tr>';
    }).join("") || '<tr><td colspan="4">لا توجد مشتريات.</td></tr>';
    var consumptionRows = (report.consumption_rows || []).map(function (row) {
      return '<tr><td>' + escapeHtml(row.name) + '</td><td dir="ltr">' + row.quantity + ' ' +
        escapeHtml(row.unit || "") + '</td><td dir="ltr">' + money(row.cost) + '</td></tr>';
    }).join("") || '<tr><td colspan="3">لا يوجد استهلاك.</td></tr>';
    var logRows = (report.log || []).map(function (entry) {
      return '<tr><td>' + escapeHtml(entry.event_time_display || formatDateTime(entry.event_time)) +
        '</td><td>' + escapeHtml(entry.title || "") + '</td><td>' + escapeHtml(entry.details || "") + '</td></tr>';
    }).join("") || '<tr><td colspan="3">لا يوجد سجل.</td></tr>';
    detail.innerHTML =
      '<h3>تفاصيل يوم ' + escapeHtml(formatDateOnly(report.key)) + '</h3>' +
      '<div class="metric-grid">' +
        '<div class="metric-card"><span>المبيعات</span><strong dir="ltr">' + money(report.revenue) + '</strong></div>' +
        '<div class="metric-card"><span>المرتجعات</span><strong dir="ltr">' + money(report.returns_total) + '</strong></div>' +
        '<div class="metric-card"><span>المصروفات</span><strong dir="ltr">' + money(report.expenses) + '</strong></div>' +
        '<div class="metric-card"><span>المشتريات</span><strong dir="ltr">' + money(report.purchases_total) + '</strong></div>' +
        '<div class="metric-card"><span>تكلفة الاستهلاك</span><strong dir="ltr">' + money(report.consumption_cost) + '</strong></div>' +
        '<div class="metric-card"><span>صافي الربح</span><strong dir="ltr">' + money(report.profit) + '</strong></div>' +
      '</div>' +
      '<h3>الورديات والكاشير</h3>' + projectShiftBlocks(report.shift_breakdown) +
      '<h3>المصروفات</h3><div class="table-wrap"><table><thead><tr><th>البند</th><th>المبلغ</th><th>ملاحظة</th></tr></thead><tbody>' + expenseRows + '</tbody></table></div>' +
      '<h3>المشتريات</h3><div class="table-wrap"><table><thead><tr><th>الوقت والتاريخ</th><th>المورد</th><th>البند</th><th>المبلغ</th></tr></thead><tbody>' + purchaseRows + '</tbody></table></div>' +
      '<h3>الاستهلاك</h3><div class="table-wrap"><table><thead><tr><th>المادة</th><th>الكمية</th><th>التكلفة</th></tr></thead><tbody>' + consumptionRows + '</tbody></table></div>' +
      '<h3>سجل ما حدث</h3><div class="table-wrap"><table><thead><tr><th>الوقت والتاريخ</th><th>الحدث</th><th>التفاصيل</th></tr></thead><tbody>' + logRows + '</tbody></table></div>';
    detail.hidden = false;
    detail.scrollIntoView();
  }

  function loadProjectDays() {
    var body = document.getElementById("cashier-projects-body");
    var detail = document.getElementById("cashier-project-detail");
    if (!body) return;
    if (detail) {
      detail.hidden = true;
      detail.innerHTML = "";
    }
    body.innerHTML = '<tr><td colspan="7">جارٍ تحميل أيام العمل...</td></tr>';
    requestJson("/api/projects", null, function (error, rows) {
      if (error) {
        body.innerHTML = '<tr><td colspan="7">تعذر تحميل المشاريع اليومية: ' + escapeHtml(error.message) + '</td></tr>';
        return;
      }
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="7">لا توجد أيام عمل.</td></tr>';
        return;
      }
      body.innerHTML = rows.map(function (row) {
        return '<tr><td>' + escapeHtml(formatDateOnly(row.project_date)) +
          '</td><td dir="ltr">' + money(row.sales) + '</td><td dir="ltr">' + money(row.expenses) +
          '</td><td dir="ltr">' + money(row.cash_balance) + '</td><td dir="ltr">' + money(row.closing_variance) +
          '</td><td>' + (row.status === "open" ? "مفتوح" : "مغلق") +
          '</td><td><button type="button" class="button button-secondary small-btn" data-project-date="' +
          escapeHtml(row.project_date) + '">عرض التفاصيل</button></td></tr>';
      }).join("");
    });
  }

  var cashierProjectsBody = document.getElementById("cashier-projects-body");
  if (cashierProjectsBody) {
    cashierProjectsBody.addEventListener("click", function (event) {
      var button = findDataElement(event.target, "data-project-date", cashierProjectsBody);
      if (!button) return;
      var day = button.getAttribute("data-project-date");
      var detail = document.getElementById("cashier-project-detail");
      if (detail) {
        detail.hidden = false;
        detail.innerHTML = '<p class="muted">جارٍ تحميل التفاصيل...</p>';
      }
      requestJson("/api/projects/report?period=day&date=" + encodeURIComponent(day), null, function (error, report) {
        if (error) {
          if (detail) detail.innerHTML = '<p class="form-message error">تعذر تحميل التفاصيل: ' + escapeHtml(error.message) + '</p>';
          return;
        }
        renderProjectDetail(report);
      });
    });
  }

  function renderCashierProductSearchResults(matches, container) {
    var html = "";
    var i;
    var item;
    var typeLabel;
    var sub;
    if (!matches.length) {
      container.innerHTML = '<div class="global-search-empty">لا توجد منتجات مطابقة في نقطة البيع.</div>';
      container.hidden = false;
      return;
    }
    for (i = 0; i < Math.min(matches.length, 10); i += 1) {
      item = matches[i];
      typeLabel = item.kind === "book"
        ? (item.type === "Original" ? "Original" : item.type === "High Copy" ? "High Copy" : "كتاب")
        : (item.kind === "drink" ? (item.category_label || (item.category === "cold" ? "مشروب بارد" : "مشروب ساخن")) : "منتج جاهز");
      sub = typeLabel + " • " + money(item.sell_price) + " ج.م";
      html += '<button type="button" class="global-search-result" role="option" data-product-id="' +
        Number(item.id) + '" data-product-kind="' + escapeHtml(item.kind) + '">' +
        '<strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(sub) + '</small></button>';
    }
    container.innerHTML = html;
    container.hidden = false;
  }

  function runCashierProductSearch(query, container) {
    var q = query.toLowerCase();
    var matches = [];
    var i;
    var item;
    for (i = 0; i < products.length; i += 1) {
      item = products[i];
      if (item.name.toLowerCase().indexOf(q) >= 0 || (item.author && item.author.toLowerCase().indexOf(q) >= 0)) {
        matches.push(item);
      }
    }
    renderCashierProductSearchResults(matches, container);
  }

  function bindCashierGlobalSearch() {
    var results = document.getElementById("cashier-search-results");
    if (!searchInput || !results) return;
    searchInput.addEventListener("input", function () {
      var query = searchInput.value.replace(/^\s+|\s+$/g, "");
      if (systemSearchTimer) clearTimeout(systemSearchTimer);
      if (!query) {
        results.hidden = true;
        results.innerHTML = "";
        return;
      }
      systemSearchTimer = setTimeout(function () {
        runCashierProductSearch(query, results);
      }, 150);
    });
    results.addEventListener("click", function (event) {
      var button = event.target.closest("[data-product-id]");
      if (!button) return;
      var id = button.getAttribute("data-product-id");
      var kind = button.getAttribute("data-product-kind");
      var product = productFor(id, kind);
      results.hidden = true;
      if (currentCashierView !== "pos") {
        setCashierView("pos");
      }
      if (product) {
        addToCart(product);
      }
    });
    document.addEventListener("click", function (event) {
      if (!searchInput.contains(event.target) && !results.contains(event.target)) results.hidden = true;
    });
    searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Escape") results.hidden = true;
    });
  }

  function recipeFor(product) {
    return product && Object.prototype.toString.call(product.recipe) === "[object Array]"
      ? product.recipe : [];
  }

  function productFor(id, kind) {
    var i;
    for (i = 0; i < products.length; i += 1) {
      if (String(products[i].id) === String(id) && products[i].kind === kind) return products[i];
    }
    return null;
  }

  function reservedFor(map, id) {
    return Number(map[String(id)] || 0);
  }

  function getAvailableUnits(product) {
    var i;
    var available;
    var recipe;
    var stock;
    var reserved;
    if (product.kind === "book" || product.kind === "retail") {
      stock = Math.max(0, Number(product.stock != null ? product.stock : product.stock_quantity || 0));
      return Math.max(0, stock - reservedFor(reservedStock[product.kind === "book" ? "books" : "retail"], product.id));
    }
    if (product.max_sellable_qty === 0 || !product.recipe_valid && product.recipe_valid !== undefined) return 0;
    if (product.max_sellable_qty === null || product.max_sellable_qty === undefined) return Infinity;
    recipe = recipeFor(product);
    available = Infinity;
    for (i = 0; i < recipe.length; i += 1) {
      stock = Number(recipe[i].current_stock);
      reserved = reservedFor(reservedStock.materials, recipe[i].material_id);
      if (!(Number(recipe[i].qty) > 0) || !isFinite(stock)) return 0;
      available = Math.min(available, Math.floor(Math.max(0, stock - reserved) / Number(recipe[i].qty) + 0.000000001));
    }
    return available;
  }

  function renderProducts() {
    var filteredProducts;
    var query = searchInput ? searchInput.value.trim().toLowerCase() : "";
    var i;
    var product;
    var button;
    var isOut;
    var detailText;
    var subDetailText;
    var remaining;
    if (!grid) return;

    filteredProducts = products.filter(function (item) {
      var matchesSearch = !query || item.name.toLowerCase().indexOf(query) >= 0 ||
        item.author && item.author.toLowerCase().indexOf(query) >= 0;
      var tabParts = currentCategory.split(":");
      var matchesCategory = currentCategory === "all" ||
        currentCategory === "book" && item.kind === "book" ||
        tabParts[0] === "drink" && item.kind === "drink" &&
          (item.category === "cold" ? "iced" : item.category) === tabParts[1] ||
        tabParts[0] === "retail" && item.kind === "retail" && item.category === tabParts[1];
      return matchesSearch && matchesCategory;
    });
    grid.innerHTML = "";
    if (!filteredProducts.length) {
      grid.innerHTML = '<p class="empty-message">لا توجد منتجات مطابقة في هذا التصنيف.</p>';
      return;
    }

    for (i = 0; i < filteredProducts.length; i += 1) {
      product = filteredProducts[i];
      remaining = getAvailableUnits(product);
      isOut = remaining < 1;
      button = document.createElement("button");
      button.className = "product-card" + (isOut ? " stock-empty" : "");
      button.disabled = isOut;
      if (product.kind === "book" || product.kind === "retail") {
        detailText = isOut ? "نفد المخزون" : remaining + " متاح";
        subDetailText = product.kind === "book"
          ? product.type === "Original" ? "Original" : product.type === "High Copy" ? "High Copy" : product.type || ""
          : categoryLabel(product.category) || product.category_label || "";
      } else {
        detailText = isOut ? "نفد المخزون" : remaining === Infinity ? "متوفر" : remaining + " متاح";
        subDetailText = categoryLabel(product.category === "cold" ? "iced" : product.category) ||
          product.category_label || "مشروب ساخن";
      }
      button.innerHTML =
        '<div class="p-name">' + escapeHtml(product.name) + '</div>' +
        (subDetailText ? '<div class="p-sub-detail">' + escapeHtml(subDetailText) + '</div>' : "") +
        '<div class="p-price" dir="ltr">' + money(product.sell_price) + ' ج.م</div>' +
        '<div class="p-type-badge">' + escapeHtml(detailText) + '</div>';
      button.addEventListener("click", (function (selectedProduct) {
        return function () { addToCart(selectedProduct); };
      }(product)));
      grid.appendChild(button);
    }
  }

  function recalculateReservations() {
    var i;
    var j;
    var item;
    var product;
    var recipe;
    var materialId;
    var amount;
    reservedStock = {materials: {}, books: {}, retail: {}};
    for (i = 0; i < cart.length; i += 1) {
      item = cart[i];
      if (item.kind === "book" || item.kind === "retail") {
        var stockMap = item.kind === "book" ? reservedStock.books : reservedStock.retail;
        stockMap[String(item.id)] = reservedFor(stockMap, item.id) + Number(item.quantity);
        continue;
      }
      product = productFor(item.id, item.kind) || item;
      recipe = recipeFor(product);
      for (j = 0; j < recipe.length; j += 1) {
        materialId = String(recipe[j].material_id);
        amount = Number(recipe[j].qty) * Number(item.quantity);
        reservedStock.materials[materialId] = reservedFor(reservedStock.materials, materialId) + amount;
      }
    }
    return reservedStock;
  }

  function reservationFailure() {
    var i;
    var j;
    var item;
    var product;
    var recipe;
    var stock;
    var reserved;
    var material;
    for (i = 0; i < cart.length; i += 1) {
      item = cart[i];
      product = productFor(item.id, item.kind) || item;
      if (product.kind === "book" || product.kind === "retail") {
        reserved = reservedFor(
          product.kind === "book" ? reservedStock.books : reservedStock.retail,
          product.id
        );
        stock = Number(product.stock != null ? product.stock : product.stock_quantity || 0);
        if (reserved > stock + 0.000000001) {
          return {product: product.name, material: product.name, kind: product.kind};
        }
      } else {
        recipe = recipeFor(product);
        if (product.max_sellable_qty === 0 && cartContains(product.id, "drink")) {
          return {product: product.name, material: "recipe stock", kind: "drink"};
        }
        for (j = 0; j < recipe.length; j += 1) {
          material = recipe[j];
          reserved = reservedFor(reservedStock.materials, material.material_id);
          stock = Number(material.current_stock);
          if (!isFinite(stock) || reserved > stock + 0.000000001) {
            return {product: product.name, material: material.material_name || "ingredient", kind: "drink"};
          }
        }
      }
    }
    return null;
  }

  function cartContains(id, kind) {
    var i;
    for (i = 0; i < cart.length; i += 1) {
      if (String(cart[i].id) === String(id) && cart[i].kind === kind) return true;
    }
    return false;
  }

  function canAddToCart(product) {
    var i;
    var recipe;
    var material;
    var available;
    lastStockFailure = null;
    if (product.kind === "book" || product.kind === "retail") {
      available = Number(product.stock != null ? product.stock : product.stock_quantity || 0) - reservedFor(
        product.kind === "book" ? reservedStock.books : reservedStock.retail,
        product.id
      );
      if (available < 1) {
        lastStockFailure = {material: product.name, kind: product.kind};
        return false;
      }
      return true;
    }
    recipe = recipeFor(product);
    if (!recipe.length) {
      if (product.max_sellable_qty !== null && product.max_sellable_qty !== undefined) {
        lastStockFailure = {material: "recipe stock", kind: "drink"};
        return false;
      }
      return true;
    }
    for (i = 0; i < recipe.length; i += 1) {
      material = recipe[i];
      available = Number(material.current_stock) - reservedFor(reservedStock.materials, material.material_id);
      if (!(Number(material.qty) > 0) || available + 0.000000001 < Number(material.qty)) {
        lastStockFailure = {material: material.material_name || "ingredient", kind: "drink"};
        return false;
      }
    }
    return true;
  }

  function showStockFailure(product, failure) {
    var reason = failure && (failure.kind === "book" || failure.kind === "retail")
      ? failure.kind === "book" ? "مخزون الكتاب المتاح" : "مخزون المنتج الجاهز المتاح"
      : "المادة الخام " + (failure ? failure.material : "المخزون");
    var text = "لا يمكن إضافة " + product.name + ". المخزون غير كافٍ لـ " + reason + ".";
    showMessage(text, "error");
    if (window.alert) window.alert(text);
  }

  function addToCart(product) {
    var i;
    var existing = null;
    showMessage("", "");
    if (!canAddToCart(product)) {
      showStockFailure(product, lastStockFailure);
      return false;
    }
    for (i = 0; i < cart.length; i += 1) {
      if (String(cart[i].id) === String(product.id) && cart[i].kind === product.kind) {
        existing = cart[i];
        break;
      }
    }
    if (existing) existing.quantity += 1;
    else {
      cart.push({
        id: product.id,
        kind: product.kind,
        name: product.name,
        price: product.sell_price,
        quantity: 1,
        discount_percent: 0,
        type: product.type || "",
        category: product.category || "",
        stock: product.stock != null ? product.stock : product.stock_quantity,
        max_sellable_qty: product.max_sellable_qty,
        recipe: recipeFor(product)
      });
    }
    recalculateReservations();
    renderCart();
    renderProducts();
    return true;
  }

  window.updateQuantitySafe = function (index, delta) {
    var item = cart[index];
    var oldQuantity;
    var failure;
    if (!item) return;
    oldQuantity = Number(item.quantity);
    if (oldQuantity + delta < 1) {
      cart.splice(index, 1);
    } else {
      item.quantity = oldQuantity + delta;
      recalculateReservations();
      failure = reservationFailure();
      if (failure) {
        item.quantity = oldQuantity;
        recalculateReservations();
        showStockFailure(item, failure);
        return;
      }
    }
    recalculateReservations();
    renderCart();
    renderProducts();
  };

  window.handleManualQtyChange = function (index, newValue) {
    var item = cart[index];
    var quantity = Number(newValue);
    var oldQuantity;
    var failure;
    if (!item) return;
    if (!isFinite(quantity) || quantity < 1 || Math.floor(quantity) !== quantity) {
      showMessage("يجب أن تكون الكمية عددًا صحيحًا لا يقل عن 1.", "error");
      renderCart();
      return;
    }
    oldQuantity = Number(item.quantity);
    item.quantity = quantity;
    recalculateReservations();
    failure = reservationFailure();
    if (failure) {
      item.quantity = oldQuantity;
      recalculateReservations();
      showStockFailure(item, failure);
      renderCart();
      return;
    }
    renderCart();
    renderProducts();
  };

  window.handleDiscountChange = function (index, newValue) {
    var item = cart[index];
    var percent = Number(newValue);
    if (!item) return;
    if (!isFinite(percent) || percent < 0 || percent > 100) {
      showMessage("نسبة الخصم يجب أن تكون بين 0 و100٪.", "error");
      renderCart();
      return;
    }
    item.discount_percent = percent;
    renderCart();
  };

  function renderCart() {
    var totalSum = 0;
    var totalQuantity = 0;
    var i;
    var item;
    var row;
    var lineTotal;
    var grossTotal;
    var discountAmount;
    var subInfo;
    if (!cartItemsContainer) return;
    cartItemsContainer.innerHTML = "";
    if (!cart.length) {
      cartItemsContainer.innerHTML = '<p class="empty-message">اختر منتجًا لبدء البيع.</p>';
      if (payButton) payButton.disabled = true;
      if (clearSaleButton) clearSaleButton.disabled = true;
      var holdDisabled = document.getElementById("hold-sale-button");
      if (holdDisabled) holdDisabled.disabled = true;
      if (totalAmountSpan) totalAmountSpan.textContent = "0.00";
      cartTotal = 0;
      updateChangeHint();
      return;
    }
    for (i = 0; i < cart.length; i += 1) {
      item = cart[i];
      totalQuantity += Number(item.quantity) || 0;
      row = document.createElement("div");
      row.className = "cart-line";
      grossTotal = item.price * item.quantity;
      discountAmount = grossTotal * Number(item.discount_percent || 0) / 100;
      lineTotal = grossTotal - discountAmount;
      totalSum += lineTotal;
      subInfo = money(item.price) + (item.type ? " • " + item.type : "");
      row.innerHTML =
        '<div class="cart-line-info"><div class="cart-line-name">' + escapeHtml(item.name) + '</div>' +
        '<div class="cart-line-sub">' + escapeHtml(subInfo) + '</div>' +
        '<label class="cart-discount">خصم % <input type="number" id="discount-input-' + i + '" value="' +
        Number(item.discount_percent || 0) + '" min="0" max="100" step="0.5" aria-label="نسبة الخصم على ' +
        escapeHtml(item.name) + '"></label></div>' +
        '<div class="quantity-control">' +
        '<button class="qty-btn" onclick="updateQuantitySafe(' + i + ', -1)">−</button>' +
        '<input type="number" id="qty-input-' + i + '" class="quantity-input" value="' + item.quantity + '" min="1" step="1">' +
        '<button class="qty-btn" onclick="updateQuantitySafe(' + i + ', 1)">+</button></div>' +
        '<div class="ci-total">' + money(lineTotal) + '</div>';
      cartItemsContainer.appendChild(row);
      (function (itemIndex) {
        var input = document.getElementById("qty-input-" + itemIndex);
        var discountInput = document.getElementById("discount-input-" + itemIndex);
        if (input) input.addEventListener("change", function (event) {
          window.handleManualQtyChange(itemIndex, event.target.value);
        });
        if (discountInput) discountInput.addEventListener("change", function (event) {
          window.handleDiscountChange(itemIndex, event.target.value);
        });
      }(i));
    }
    if (totalAmountSpan) totalAmountSpan.textContent = money(totalSum);
    if (payButton) payButton.disabled = false;
    if (clearSaleButton) clearSaleButton.disabled = false;
    var holdEnabled = document.getElementById("hold-sale-button");
    if (holdEnabled) holdEnabled.disabled = false;
    cartTotal = totalSum;
    updateChangeHint();
  }

  function clearCurrentSale() {
    if (!cart.length) return;
    if (!window.confirm("هل تريد مسح البيع الحالي وإفراغ السلة بالكامل؟")) return;
    cart = [];
    recalculateReservations();
    renderCart();
    renderProducts();
    showMessage("تم مسح البيع الحالي.", "success");
  }

  if (clearSaleButton) {
    clearSaleButton.addEventListener("click", clearCurrentSale);
  }

  if (payButton) {
    payButton.addEventListener("click", function () {
      var orderItems;
      if (!cart.length) return;
      payButton.disabled = true;
      payButton.innerHTML = "جارٍ التنفيذ...";
      showMessage("جارٍ حفظ عملية البيع...", "");
      orderItems = cart.map(function (item) {
        return {id: item.id, kind: item.kind, quantity: item.quantity, discount_percent: Number(item.discount_percent || 0)};
      });
      var payload = orderPayload(orderItems);
      if (!payload) {
        payButton.disabled = !cart.length;
        payButton.innerHTML = "دفع وطباعة 🖨️";
        return;
      }
      requestJson("/api/orders", {
        method: "POST",
        body: JSON.stringify(payload)
      }, function (error, result) {
        if (error) {
          showMessage("خطأ: " + error.message, "error");
          payButton.disabled = !cart.length;
          payButton.innerHTML = "دفع وطباعة 🖨️";
          return;
        }
        cart = [];
        recalculateReservations();
        renderCart();
        renderProducts();
        showMessage("اكتملت عملية البيع رقم " + result.order_id + ".", "success");
        loadProducts();
        loadTodaySales();
        loadRecentOrders();
        loadCashierDrawer();
        resetPaymentPanel();
        openReceiptPreview(result.order_id);
        payButton.disabled = true;
        payButton.innerHTML = "دفع وطباعة 🖨️";
        var holdSaleButton = document.getElementById("hold-sale-button");
        if (holdSaleButton) holdSaleButton.disabled = true;
      });
    });
  }

  var holdSaleButton = document.getElementById("hold-sale-button");

  if (holdSaleButton) {
    holdSaleButton.addEventListener("click", function () {
      if (!cart.length) {
        showMessage("أضف صنفًا إلى السلة قبل تعليق الطلب.", "error");
        return;
      }
      holdSaleButton.disabled = true;
      var orderItems = cart.map(function (item) {
        return {id:item.id, kind:item.kind, quantity:item.quantity, discount_percent:Number(item.discount_percent || 0)};
      });
      var payload = orderPayload(orderItems);
      if (!payload) return;
      payload.action = "pending";
      requestJson("/api/orders", {method:"POST", body:JSON.stringify(payload)}, function(error, result) {
        holdSaleButton.disabled=false;
        if (error) { showMessage("تعذر تعليق الطلب: " + error.message, "error"); return; }
        cart=[]; recalculateReservations(); renderCart(); renderProducts(); resetPaymentPanel();
        showMessage("تم تعليق الطلب رقم " + result.order_id + ".", "success");
        holdSaleButton.disabled=true;
        loadPendingOrders(); loadCashierDrawer();
      });
    });
  }

  function loadPendingOrders() {
    var target=document.getElementById("cashier-pending-orders");
    var badge=document.getElementById("cashier-pending-badge");
    if (!target) return;
    target.innerHTML='<p class="muted">جارٍ تحميل الطلبات المعلقة...</p>';
    requestJson("/api/orders/pending", null, function(error, orders) {
      if (error) { target.innerHTML='<p class="form-message error">تعذر تحميل الطلبات المعلقة.</p>'; return; }
      orders=orders || [];
      if (badge) { badge.hidden=!orders.length; badge.textContent=String(orders.length); }
      if (!orders.length) { target.innerHTML='<p class="muted">لا توجد طلبات معلقة حالياً.</p>'; return; }
      target.innerHTML=orders.map(function(order) {
        var names=(order.items || []).map(function(item){return escapeHtml(item.name || "") + " × " + escapeHtml(item.quantity || 1);}).join(" · ");
        return '<article class="pending-order-card"><div><strong>طلب #' + escapeHtml(order.id) + '</strong><span dir="ltr">' + money(order.total_amount) + ' ج.م</span></div><small>' + escapeHtml(order.employee_name) + ' · ' + formatDateTime(order.timestamp) + '</small><p>' + names + '</p><div class="pending-order-actions"><button type="button" class="button button-primary" data-complete-pending="' + Number(order.id) + '">دفع وطباعة 🖨️</button></div></article>';
      }).join("");
    });
  }

  var pendingTarget=document.getElementById("cashier-pending-orders");
  if (pendingTarget) {
    pendingTarget.addEventListener("click",function(event){
      var button=findDataElement(event.target,"data-complete-pending",pendingTarget); if(!button)return;
      var id=Number(button.getAttribute("data-complete-pending"));
      button.disabled=true;
      var method=document.getElementById("payment-method");
      var paid=document.getElementById("paid-amount");
      var paidValue=paid&&paid.value!==""?parseLocalizedAmount(paid.value):null;
      if(paid&&paid.value!==""&&(paidValue===null||paidValue<0)){button.disabled=false;showMessage("أدخل مبلغًا صالحًا باستخدام الأرقام العربية أو الإنجليزية.","error");return;}
      var payload={payment_method:method&&method.value?method.value:"نقدي"};
      if(paidValue!==null) payload.paid_amount=paidValue;
      requestJson("/api/orders/"+id+"/complete",{method:"POST",body:JSON.stringify(payload)},function(error,result){
        if(error){button.disabled=false;showMessage("تعذر إكمال الطلب: "+error.message,"error");return;}
        loadPendingOrders(); loadProducts(); loadTodaySales(); loadCashierDrawer(); loadRecentOrders(); openReceiptPreview(result.order_id);
      });
    });
  }
  var refreshPending=document.getElementById("refresh-pending-orders");
  if(refreshPending) refreshPending.addEventListener("click",loadPendingOrders);

  function loadEmployeeState() {
    requestJson("/api/employee/current", null, function (error, payload) {
      var loginForm = document.getElementById("employee-attendance-form");
      var current = document.getElementById("attendance-current");
      var presence = document.getElementById("attendance-open-shifts");
      if (error || !payload.authenticated) {
        if (presence) renderOpenShiftPresence(presence, payload && payload.open_shifts || []);
        if (loginForm) loginForm.hidden = false;
        if (current) current.hidden = true;
        currentEmployeeName = "";
        setDrawerChip(null);
        applyReturnEmployeeName("");
        return;
      }
      if (presence) renderOpenShiftPresence(presence, payload.open_shifts || []);
      if (loginForm) loginForm.hidden = true;
      if (current) current.hidden = false;
      currentEmployeeName = payload.employee.username;
      applyReturnEmployeeName(currentEmployeeName);
      document.getElementById("attendance-employee-name").textContent = "الموظف: " + payload.employee.username;
      document.getElementById("attendance-started-at").textContent = payload.shift ? formatDateTime(payload.shift.started_at) : "لا توجد وردية مفتوحة";
      document.getElementById("attendance-shift-hours").textContent = payload.shift_hours + " ساعة";
      document.getElementById("attendance-cash-drawer").textContent = money(payload.cash_drawer) + " ج.م";
      setDrawerChip(payload.cash_drawer);
      receiptAutoPrint = payload.receipt_auto_print === true;
      var closeCash = document.getElementById("attendance-close-cash");
      var closeCashField = document.getElementById("attendance-close-cash-field");
      var sharedDrawerNote = document.getElementById("attendance-shared-drawer-note");
      var reconciliationRequired = payload.cash_reconciliation_required !== false;
      if (closeCashField) closeCashField.hidden = !reconciliationRequired;
      if (sharedDrawerNote) sharedDrawerNote.hidden = reconciliationRequired;
      if (closeCash) closeCash.value = payload.cash_drawer;
    });
  }

  function renderOpenShiftPresence(target, shifts) {
    var labels = [
      ["can_sell", "بيع"],
      ["can_manage_inventory", "إدارة الأصناف"],
      ["can_manage_expenses", "إدارة المصروفات"],
      ["can_manage_purchases", "إدارة المشتريات"]
    ];
    if (!shifts.length) {
      target.innerHTML = '<p class="muted">لا يوجد موظفون على وردية مفتوحة حاليًا.</p>';
      return;
    }
    target.innerHTML = '<h3>الموظفون المتواجدون على الورديات المفتوحة</h3>' +
      '<div class="attendance-presence-list">' + shifts.map(function (shift) {
        var permissions = labels.filter(function (item) {
          return !!shift[item[0]];
        }).map(function (item) {
          return '<span class="attendance-permission">' + item[1] + '</span>';
        }).join("");
        return '<article class="attendance-presence-card">' +
          '<div class="attendance-presence-heading"><strong>' + escapeHtml(shift.username) +
          '</strong><span>حاضر · ' + escapeHtml(formatDateTime(shift.started_at)) + '</span></div>' +
          '<div class="attendance-presence-permissions">' +
          (permissions || '<span class="muted">لا توجد صلاحيات تشغيلية</span>') +
          '</div><button type="button" class="button button-secondary small-btn attendance-close-shift" ' +
          'data-close-employee-shift="' + Number(shift.shift_id) + '" data-employee-name="' +
          escapeHtml(shift.username) + '" data-cash-reconciliation="' +
          (shift.cash_reconciliation_required ? "true" : "false") + '">إنهاء وردية</button></article>';
      }).join("") + '</div><div id="employee-shift-close-modal" class="cat-modal" hidden></div>';
    target.onclick = function (event) {
      var clicked = event.target.closest
        ? event.target.closest("[data-close-employee-shift], [data-close-employee-submit], [data-close-employee-cancel]")
        : null;
      var modal = document.getElementById("employee-shift-close-modal");
      var input;
      var payload;
      if (!clicked || !modal || clicked.disabled) return;
      if (clicked.hasAttribute("data-close-employee-cancel")) {
        modal.hidden = true;
        modal.innerHTML = "";
        return;
      }
      if (clicked.hasAttribute("data-close-employee-submit")) {
        payload = {};
        input = modal.querySelector("#employee-shift-close-password");
        if (clicked.getAttribute("data-requires-password") === "true") {
          if (!input || !input.value) {
            showAttendanceMessage("كلمة مرور الموظف مطلوبة.", false);
            if (input) input.focus();
            return;
          }
          payload.password = input.value;
        }
        input = modal.querySelector("#employee-shift-close-cash");
        if (clicked.getAttribute("data-requires-cash") === "true") {
          if (!input || !input.value.trim()) {
            showAttendanceMessage("رصيد الدرج المعدود مطلوب لإنهاء آخر وردية.", false);
            if (input) input.focus();
            return;
          }
          payload.counted_cash = input.value;
        }
        clicked.disabled = true;
        requestJson("/api/employee/shift/" + clicked.getAttribute("data-shift-id") + "/close", {
          method: "POST",
          body: JSON.stringify(payload)
        }, function (error, result) {
          if (error) {
            clicked.disabled = false;
            showAttendanceMessage(
              "تعذر إنهاء وردية " + clicked.getAttribute("data-employee-name") + ": " + error.message,
              false
            );
            return;
          }
          modal.hidden = true;
          modal.innerHTML = "";
          showAttendanceMessage(
            "تم إنهاء وردية " + result.employee + " فقط." +
            (result.cash_reconciliation_required
              ? ""
              : " ستتم تسوية الدرج المشترك عند إنهاء آخر وردية."),
            true
          );
          loadEmployeeState();
        });
        return;
      }

      var employeeName = clicked.getAttribute("data-employee-name");
      var requiresPassword = employeeName !== currentEmployeeName;
      var requiresCash = clicked.getAttribute("data-cash-reconciliation") === "true";
      modal.innerHTML = '<div class="cat-modal-backdrop"><section class="cat-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-shift-close-title">' +
        '<h3 id="employee-shift-close-title">إنهاء وردية «' + escapeHtml(employeeName) + '»</h3>' +
        '<p>سيتم إنهاء وردية هذا الموظف فقط.</p>' +
        (requiresPassword
          ? '<label for="employee-shift-close-password">كلمة مرور الموظف</label><input id="employee-shift-close-password" type="password" autocomplete="current-password" required>'
          : '') +
        (requiresCash
          ? '<label for="employee-shift-close-cash">رصيد الدرج المشترك المعدود</label><input id="employee-shift-close-cash" type="number" min="0" step="0.01" required>'
          : '<p class="muted">ستتم تسوية الدرج عند إنهاء آخر وردية مفتوحة.</p>') +
        '<div class="cat-modal-actions"><button type="button" class="button button-danger" data-close-employee-submit data-shift-id="' +
        Number(clicked.getAttribute("data-close-employee-shift")) + '" data-employee-name="' +
        escapeHtml(employeeName) + '" data-requires-password="' + requiresPassword +
        '" data-requires-cash="' + requiresCash + '">تأكيد إنهاء الوردية</button>' +
        '<button type="button" class="button button-secondary" data-close-employee-cancel>إلغاء</button></div></section></div>';
      modal.hidden = false;
      input = modal.querySelector(requiresPassword
        ? "#employee-shift-close-password" : "#employee-shift-close-cash");
      if (input) input.focus();
    };
  }

  var attendanceForm = document.getElementById("employee-attendance-form");
  if (attendanceForm) {
    attendanceForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var handoverCashField = document.getElementById("handover-cash-field");
      var countedCash = document.getElementById("attendance-counted-cash");
      var payload = {
        username: document.getElementById("attendance-username").value.trim(),
        password: document.getElementById("attendance-password").value
      };
      if (!payload.username || !payload.password) {
        showAttendanceMessage("اسم الموظف وكلمة المرور مطلوبان.", false);
        return;
      }
      if (handoverCashField && !handoverCashField.hidden) {
        if (countedCash.value === "" || Number(countedCash.value) < 0) {
          showAttendanceMessage("أدخل رصيد الدرج المعدود لتأكيد الاستلام.", false);
          return;
        }
        payload.counted_cash = countedCash.value;
      }
      requestJson("/api/employee/login", {
        method: "POST",
        body: JSON.stringify(payload)
      }, function (error, result) {
        if (result && result.handover_required) {
          handoverCashField.hidden = false;
          document.getElementById("handover-message").textContent =
            "تسليم من " + result.outgoing_employee + " · الرصيد المتوقع " +
            money(result.expected_cash) + " ج.م · الوردية " + result.shift_hours + " ساعات";
          showAttendanceMessage(result.message, false);
          countedCash.focus();
          return;
        }
        if (error) {
          showAttendanceMessage(error.message, false);
          return;
        }
        handoverCashField.hidden = true;
        countedCash.value = "";
        document.getElementById("attendance-password").value = "";
        showAttendanceMessage(result.parallel_presence
          ? "تم تسجيل الحضور بالتزامن؛ سيظل الدرج مشتركًا مع الموظف الآخر."
          : "تم تسجيل الحضور وبدء الوردية.", true);
        loadEmployeeState();
      });
    });
  }

  var closeAttendanceButton = document.getElementById("attendance-close-button");
  var handoverStartButton = document.getElementById("attendance-handover-start");
  if (handoverStartButton) {
    handoverStartButton.addEventListener("click", function () {
      var loginForm = document.getElementById("employee-attendance-form");
      if (loginForm) loginForm.hidden = false;
      document.getElementById("attendance-username").focus();
    });
  }

  if (closeAttendanceButton) {
    closeAttendanceButton.addEventListener("click", function () {
      var countedCash = document.getElementById("attendance-close-cash").value;
      var closeCashField = document.getElementById("attendance-close-cash-field");
      var reconciliationRequired = !closeCashField || !closeCashField.hidden;
      if (reconciliationRequired && (countedCash === "" || Number(countedCash) < 0)) {
        showAttendanceMessage("أدخل رصيد الدرج المعدود قبل إنهاء الوردية.", false);
        return;
      }
      closeAttendanceButton.disabled = true;
      var closePayload = {reason: "attendance_close"};
      if (reconciliationRequired) closePayload.counted_cash = countedCash;
      requestJson("/api/employee/shift/close", {
        method: "POST",
        body: JSON.stringify(closePayload)
      }, function (error, result) {
        closeAttendanceButton.disabled = false;
        if (error) {
          showAttendanceMessage(error.message, false);
          return;
        }
        var closeMessage = "تم إنهاء الوردية. ساعات العمل: " +
          Math.floor(result.worked_seconds / 3600) + " س، المستحق: " + money(result.payable_amount) + " ج.م" +
          (result.cash_reconciliation_required
            ? ""
            : " · ستتم تسوية الدرج المشترك عند إنهاء آخر وردية مفتوحة.");
        requestJson("/api/employee/logout", {method: "POST", body: JSON.stringify({})}, function () {
          showAttendanceMessage(closeMessage, true);
          loadEmployeeState();
        });
      });
    });
  }

  var projectRefreshButton = document.getElementById("refresh-projects");
  if (projectRefreshButton) projectRefreshButton.addEventListener("click", loadProjectDays);

  // --- Notifications view (Batch 4) ---
  function todayIso() {
    var now = new Date();
    return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
  }

  function currentMonthPrefix() {
    var now = new Date();
    return now.getFullYear() + "-" + pad2(now.getMonth() + 1);
  }

  function loadCashierNotifications() {
    var list = document.getElementById("cashier-notifications-list");
    var badge = document.getElementById("cashier-notif-badge");
    if (!list) return;
    list.innerHTML = '<p class="muted">جارٍ تحميل الإشعارات...</p>';
    requestJson("/api/cashier/notifications", null, function (error, payload) {
      var alerts;
      if (error) {
        list.innerHTML = '<p class="form-message error">تعذر تحميل الإشعارات: ' + escapeHtml(error.message) + '</p>';
        return;
      }
      alerts = (payload && payload.alerts) || [];
      if (badge) {
        badge.textContent = String(alerts.length);
        badge.hidden = !alerts.length;
      }
      if (!alerts.length) {
        list.innerHTML = '<p class="muted">لا توجد تنبيهات حالياً. كل الخامات والمشروبات بحالة جيدة.</p>';
        return;
      }
      list.innerHTML = alerts.map(function (alert) {
        var icon = alert.severity === "danger" ? "⛔" : "⚠️";
        return '<div class="notification-card ' + escapeHtml(alert.severity) + '">' +
          '<span class="notif-icon">' + icon + '</span>' +
          '<div><div class="notif-title">' + escapeHtml(alert.title) + '</div>' +
          '<div class="notif-detail">' + escapeHtml(alert.detail) + '</div></div></div>';
      }).join("");
    });
  }

  // --- Expenses view (Batch 4) ---
  function setExpenseMessage(text, success) {
    var target = document.getElementById("cashier-expense-message");
    if (!target) return;
    target.textContent = text || "";
    target.className = "form-message field-wide" + (success ? " success" : " error");
  }

  function loadCashierExpenses() {
    var body = document.getElementById("cashier-expenses-body");
    var metrics = document.getElementById("cashier-expense-metrics");
    if (!body) return;
    body.innerHTML = '<p class="muted">جارٍ تحميل المصروفات...</p>';
    requestJson("/api/admin/expenses", null, function (error, rows) {
      var today = todayIso();
      var monthPrefix = currentMonthPrefix();
      var todayTotal = 0;
      var monthTotal = 0;
      var grandTotal = 0;
      var perDay = {};
      var days;
      var i;
      var row;
      var amount;
      if (error) {
        body.innerHTML = '<p class="form-message error">' + escapeHtml(error.message) + '</p>';
        if (metrics) metrics.innerHTML = "";
        return;
      }
      for (i = 0; i < rows.length; i += 1) {
        row = rows[i];
        amount = Number(row.amount) || 0;
        grandTotal += amount;
        if (String(row.date) === today) todayTotal += amount;
        if (String(row.date).indexOf(monthPrefix) === 0) {
          monthTotal += amount;
          perDay[row.date] = (perDay[row.date] || 0) + amount;
        }
      }
      if (metrics) {
        metrics.innerHTML =
          '<div class="metric-card"><span>مصروفات اليوم</span><strong dir="ltr">' + money(todayTotal) + '</strong></div>' +
          '<div class="metric-card"><span>مصروفات الشهر الحالي</span><strong dir="ltr">' + money(monthTotal) + '</strong></div>' +
          '<div class="metric-card"><span>إجمالي المصروفات المسجلة</span><strong dir="ltr">' + money(grandTotal) + '</strong></div>';
      }
      if (!rows.length) {
        body.innerHTML = '<p class="empty-table">لا توجد مصروفات مسجلة.</p>';
        return;
      }
      days = Object.keys(perDay).sort().reverse();
      body.innerHTML =
        '<h3>تقرير يومي — الشهر الحالي</h3>' +
        '<table><thead><tr><th>اليوم</th><th>إجمالي المصروفات</th></tr></thead><tbody>' +
        (days.map(function (day) {
          return '<tr><td>' + escapeHtml(formatDateOnly(day)) + '</td><td dir="ltr">' + money(perDay[day]) + '</td></tr>';
        }).join("") || '<tr><td colspan="2">لا توجد مصروفات هذا الشهر.</td></tr>') +
        '</tbody></table>' +
        '<h3>كل المصروفات</h3>' +
        '<table><thead><tr><th>التاريخ</th><th>البند</th><th>المبلغ</th><th>ملاحظة</th><th>إجراء</th></tr></thead><tbody>' +
        rows.map(function (item) {
          return '<tr><td>' + escapeHtml(formatDateOnly(item.date)) + '</td><td>' + escapeHtml(item.category) +
            '</td><td dir="ltr">' + money(item.amount) + '</td><td>' + escapeHtml(item.note || "") +
            '</td><td><button type="button" class="button button-danger small-btn" data-expense-delete="' +
            Number(item.id) + '">حذف</button></td></tr>';
        }).join("") +
        '</tbody></table>';
    });
  }

  var refreshNotificationsButton = document.getElementById("refresh-notifications");
  if (refreshNotificationsButton) refreshNotificationsButton.addEventListener("click", loadCashierNotifications);
  var refreshExpensesButton = document.getElementById("refresh-expenses");
  if (refreshExpensesButton) refreshExpensesButton.addEventListener("click", loadCashierExpenses);

  var cashierExpenseForm = document.getElementById("cashier-expense-form");
  if (cashierExpenseForm) {
    var expenseDateInput = document.getElementById("cexp-date");
    if (expenseDateInput) expenseDateInput.value = todayIso();
    cashierExpenseForm.addEventListener("submit", function (event) {
      var payload;
      var linkedStock;
      event.preventDefault();
      payload = {
        date: document.getElementById("cexp-date").value,
        category: document.getElementById("cexp-category").value.trim(),
        amount: document.getElementById("cexp-amount").value,
        note: document.getElementById("cexp-note").value.trim()
      };
      if (!payload.date || !payload.category || payload.amount === "") {
        setExpenseMessage("التاريخ والبند والمبلغ حقول مطلوبة.", false);
        return;
      }
      linkedStock = expenseStockPayload();
      if (linkedStock) payload.stock_item = linkedStock;
      requestJson("/api/admin/expenses", {method: "POST", body: JSON.stringify(payload)}, function (error) {
        if (error) {
          setExpenseMessage(error.message, false);
          return;
        }
        setExpenseMessage(linkedStock
          ? "تم تسجيل المصروف وزيادة مخزون " + linkedStock.name + "."
          : "تم تسجيل المصروف وربطه بصندوق الدرج والسجلات.", true);
        cashierExpenseForm.reset();
        if (expenseDateInput) expenseDateInput.value = todayIso();
        expenseStockItem = null;
        renderCashierExpenseStock();
        loadCashierExpenses();
        loadCashierDrawer();
        loadCashierClosing();
        loadProducts();
      });
    });
  }

  var cashierExpensesBody = document.getElementById("cashier-expenses-body");
  if (cashierExpensesBody) {
    cashierExpensesBody.addEventListener("click", function (event) {
      var button = findDataElement(event.target, "data-expense-delete", cashierExpensesBody);
      if (!button) return;
      var expenseId = button.getAttribute("data-expense-delete");
      if (!window.confirm("تأكيد حذف المصروف رقم " + expenseId + "؟ سيُحذف قيده من الدرج أيضاً.")) return;
      requestJson("/api/admin/expenses/" + expenseId, {method: "DELETE"}, function (error) {
        if (error) {
          setExpenseMessage(error.message, false);
          return;
        }
        setExpenseMessage("تم حذف المصروف.", true);
        loadCashierExpenses();
        loadCashierDrawer();
        loadCashierClosing();
      });
    });
  }

  var cashierNavButtons = document.querySelectorAll(".sidebar-nav [data-cashier-view]");
  for (var navIndex = 0; navIndex < cashierNavButtons.length; navIndex += 1) {
    cashierNavButtons[navIndex].addEventListener("click", function () {
      setCashierView(this.getAttribute("data-cashier-view"));
    });
  }

  window.openSettingsModal = function () {
    if (settingsModal) {
      settingsModal.style.display = "flex";
      loadRecentOrders();
    }
  };

  window.closeSettingsModal = function () {
    if (settingsModal) settingsModal.style.display = "none";
  };

  function loadRecentOrders() {
    if (!recentOrdersList) return;
    var searchBox = document.getElementById("sales-history-search");
    var dateBox = document.getElementById("sales-history-date");
    var statusBox = document.getElementById("sales-history-status");
    var employeeBox = document.getElementById("sales-history-employee");
    var params = [];
    if (searchBox && searchBox.value.trim()) params.push("q=" + encodeURIComponent(searchBox.value.trim()));
    if (dateBox && dateBox.value) params.push("date=" + encodeURIComponent(dateBox.value));
    if (statusBox && statusBox.value) params.push("status=" + encodeURIComponent(statusBox.value));
    if (employeeBox && employeeBox.value.trim()) params.push("employee=" + encodeURIComponent(employeeBox.value.trim()));
    recentOrdersList.innerHTML = '<li class="history-placeholder">جارٍ تحميل السجل...</li>';
    requestJson("/api/cashier/recent-orders" + (params.length ? "?" + params.join("&") : ""), null, function (error, orders) {
      var i;
      var html = "";
      if (error) {
        recentOrdersList.innerHTML = '<li class="history-error">تعذر تحميل سجل المبيعات</li>';
        return;
      }
      if (!orders.length) {
        recentOrdersList.innerHTML = '<li class="history-placeholder">لا توجد عمليات مطابقة.</li>';
        return;
      }
      for (i = 0; i < orders.length; i += 1) {
        var entry = orders[i];
        var isCancelled = entry.status === "cancelled";
        html += '<li class="sale-history-item' + (isCancelled ? ' cancelled' : '') + '">' +
          '<div class="sale-history-body">' +
          '<strong>#' + escapeHtml(entry.id) + ' · ' + money(entry.total_amount) + ' ج.م</strong>' +
          '<span class="status-badge ' + (isCancelled ? 'cancelled">مسترجعة' : 'completed">مكتملة') + '</span>' +
          '<div class="sale-history-meta">' + formatDateTime(entry.timestamp) + ' · ' + escapeHtml(entry.employee_name) + '</div>' +
          '<small>' + escapeHtml(entry.items || "بدون أصناف") +
          (entry.items_count ? ' · ' + entry.items_count + ' قطعة' : '') + '</small>' +
          (isCancelled && entry.cancel_reason ?
            '<div class="return-reason-note">سبب الاسترجاع: ' + escapeHtml(entry.cancel_reason) +
            (entry.performed_by_name ? ' · بواسطة: ' + escapeHtml(entry.performed_by_name) : '') +
            '</div>' : '') +
          '</div>' +
          (isCancelled ? '' :
            '<button type="button" class="button button-danger" data-return-order="' +
            Number(entry.id) + '">استرجاع</button>') +
          '</li>';
      }
      recentOrdersList.innerHTML = html;
    });
  }

  function setReturnMessage(text, success) {
    var target = document.getElementById("return-message");
    if (!target) return;
    target.textContent = text || "";
    target.className = "form-message" + (success ? " success" : " error");
  }

  function returnSelectedOrder(orderId, button) {
    var reasonInput = document.getElementById("return-reason");
    var employeeInput = document.getElementById("return-employee-name");
    var reason = reasonInput ? reasonInput.value.trim() : "";
    var employeeName = currentEmployeeName || (employeeInput ? employeeInput.value.trim() : "");
    if (!employeeName) {
      setReturnMessage("لا يوجد موظف مسجّل لتنفيذ الاسترجاع. سجّل الحضور أولاً.", false);
      return;
    }
    if (!reason) {
      setReturnMessage("سبب الاسترجاع مطلوب قبل اختيار العملية.", false);
      if (reasonInput) reasonInput.focus();
      return;
    }
    if (!window.confirm("تأكيد استرجاع العملية #" + orderId + "؟ سيتم إعادة المخزون وتسجيل السبب.")) return;
    button.disabled = true;
    requestJson("/api/orders/" + orderId + "/void", {
      method: "POST",
      body: JSON.stringify({reason: reason, employee_name: employeeName})
    }, function (error) {
      if (error) {
        setReturnMessage(error.message, false);
        button.disabled = false;
        return;
      }
      setReturnMessage("تم استرجاع العملية #" + orderId + " وتسجيل السبب.", true);
      if (reasonInput) reasonInput.value = "";
      loadRecentOrders();
      loadProducts();
      loadTodaySales();
    });
  }

  if (recentOrdersList) {
    recentOrdersList.addEventListener("click", function (event) {
      var button = findDataElement(event.target, "data-return-order", recentOrdersList);
      if (button) returnSelectedOrder(button.getAttribute("data-return-order"), button);
    });
  }

  var historySearch = document.getElementById("sales-history-search");
  if (historySearch) {
    historySearch.addEventListener("input", function () {
      if (historySearchTimer) clearTimeout(historySearchTimer);
      historySearchTimer = setTimeout(loadRecentOrders, 180);
    });
  }

  var historyEmployee = document.getElementById("sales-history-employee");
  if (historyEmployee) {
    historyEmployee.addEventListener("input", function () {
      if (historySearchTimer) clearTimeout(historySearchTimer);
      historySearchTimer = setTimeout(loadRecentOrders, 180);
    });
  }

  var historyDate = document.getElementById("sales-history-date");
  if (historyDate) historyDate.addEventListener("change", loadRecentOrders);

  var historyStatus = document.getElementById("sales-history-status");
  if (historyStatus) historyStatus.addEventListener("change", loadRecentOrders);

  if (settingsModal) {
    settingsModal.addEventListener("click", function (event) {
      if (event.target === settingsModal) window.closeSettingsModal();
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", function () {
      renderProducts();
    });
  }

  function hideQuickResults() {
    if (quickResultsContainer) {
      quickResultsContainer.style.display = "none";
      quickResultsContainer.innerHTML = "";
    }
  }

  function showQuickResults() {
    if (quickResultsContainer) quickResultsContainer.style.display = "block";
  }

  function filterAndShowQuickResults(query) {
    var matches = [];
    var i;
    var item;
    var type;
    var html = "";
    for (i = 0; i < products.length; i += 1) {
      item = products[i];
      if (item.name.toLowerCase().indexOf(query) >= 0 ||
          item.author && item.author.toLowerCase().indexOf(query) >= 0) matches.push(item);
    }
    if (!matches.length) {
      quickResultsContainer.innerHTML = '<div class="no-results-msg">لم يتم العثور على منتجات</div>';
      showQuickResults();
      return;
    }
    for (i = 0; i < Math.min(matches.length, 7); i += 1) {
      item = matches[i];
      type = item.kind === "book"
        ? (item.type === "Original" ? "Original" : item.type === "High Copy" ? "High Copy" : "كتاب")
        : item.category_label || (item.category === "cold" ? "مشروب بارد" : "مشروب ساخن");
      html += '<div class="dropdown-item" onclick="selectQuickProduct(' + Number(item.id) + ', \'' +
        escapeHtml(item.kind) + '\')"><div><div class="di-name">' + escapeHtml(item.name) +
        '</div><div class="di-type">' + escapeHtml(type) + '</div></div><div class="di-price">' +
        money(item.sell_price) + ' ج.م</div></div>';
    }
    quickResultsContainer.innerHTML = html;
    showQuickResults();
  }

  if (quickSearchInput && quickResultsContainer) {
    quickSearchInput.addEventListener("input", function () {
      var query = this.value.trim().toLowerCase();
      clearTimeout(quickSearchTimer);
      if (!query) {
        hideQuickResults();
        return;
      }
      quickSearchTimer = setTimeout(function () {
        filterAndShowQuickResults(query);
      }, 200);
    });
    document.addEventListener("click", function (event) {
      if (!quickSearchInput.contains(event.target) && !quickResultsContainer.contains(event.target)) {
        hideQuickResults();
      }
    });
  }

  window.selectQuickProduct = function (id, kind) {
    var product = productFor(id, kind);
    if (product) addToCart(product);
    if (quickSearchInput) quickSearchInput.value = "";
    hideQuickResults();
  };

  function initCategoryTabs() {
    var tabsContainer = document.getElementById("category-tabs");
    if (!tabsContainer) return;
    tabsContainer.addEventListener("click", function (event) {
      var target = event.target;
      while (target && target !== tabsContainer && !target.classList.contains("cat-tab")) {
        target = target.parentNode;
      }
      if (!target || target === tabsContainer) return;
      var tabs = tabsContainer.querySelectorAll(".cat-tab");
      var i;
      for (i = 0; i < tabs.length; i += 1) tabs[i].classList.remove("active");
      target.classList.add("active");
      currentCategory = target.getAttribute("data-cat");
      renderProducts();
    });
  }

  function renderCategoryTabs() {
    var tabsContainer = document.getElementById("category-tabs");
    var html;
    var categories = [];
    var i;
    var product;
    var category;
    var productCategory;
    var hasCategory;
    var key;
    if (!tabsContainer) return;
    for (i = 0; i < activeCategories.length; i += 1) {
      category = activeCategories[i];
      // Books remain under the synthetic "الكتب" tab in v1.
      if (category.scope !== "drink" && category.scope !== "retail") continue;
      hasCategory = false;
      for (var k = 0; k < products.length; k += 1) {
        product = products[k];
        productCategory = product.category === "cold" ? "iced" : product.category;
        if (product.kind === category.scope && productCategory === category.slug) {
          hasCategory = true;
          break;
        }
      }
      if (hasCategory) categories.push(category);
    }
    if (currentCategory !== "all" && currentCategory !== "book" &&
        !categories.some(function (category) {
          return currentCategory === category.scope + ":" + category.slug;
        })) currentCategory = "all";
    html = '<button class="cat-tab' + (currentCategory === "all" ? " active" : "") +
      '" data-cat="all">الكل</button><button class="cat-tab' +
      (currentCategory === "book" ? " active" : "") + '" data-cat="book">الكتب</button>';
    for (i = 0; i < categories.length; i += 1) {
      key = categories[i].scope + ":" + categories[i].slug;
      html += '<button class="cat-tab tab-dyn-category' + (currentCategory === key ? " active" : "") +
        '" data-cat="' + escapeHtml(key) + '">' +
        escapeHtml(categories[i].label_ar) + '</button>';
    }
    tabsContainer.innerHTML = html;
  }

  // ==========================================
  // CASH DRAWER CHIP, TENDER PANEL AND RECEIPT PREVIEW (Batch 5)
  // ==========================================
  function setDrawerChip(amount) {
    var chip = document.getElementById("cashier-drawer-balance");
    if (!chip) return;
    if (amount === null || amount === undefined || amount === "") {
      chip.textContent = "—";
      return;
    }
    chip.textContent = money(amount) + " ج.م";
  }

  function loadCashierDrawer() {
    requestJson("/api/employee/current", null, function (error, payload) {
      if (error || !payload.authenticated) {
        setDrawerChip(null);
        return;
      }
      setDrawerChip(payload.cash_drawer);
      receiptAutoPrint = payload.receipt_auto_print === true;
    });
  }

  function orderPayload(items) {
    var payload = {items: items};
    var method = document.getElementById("payment-method");
    var paid = document.getElementById("paid-amount");
    var paidValue = paid && paid.value !== "" ? parseLocalizedAmount(paid.value) : null;
    if (paid && paid.value !== "" && (paidValue === null || paidValue < 0)) {
      showMessage("أدخل مبلغًا صالحًا باستخدام الأرقام العربية أو الإنجليزية.", "error");
      return null;
    }
    payload.payment_method = method && method.value ? method.value : "نقدي";
    if (paidValue !== null) payload.paid_amount = paidValue;
    return payload;
  }

  function parseLocalizedAmount(value) {
    var normalized = String(value || "")
      .replace(/[٠-٩]/g, function (digit) { return String(digit.charCodeAt(0) - 1632); })
      .replace(/[۰-۹]/g, function (digit) { return String(digit.charCodeAt(0) - 1776); })
      .replace(/٫/g, ".")
      .replace(/٬/g, "")
      .replace(/,/g, function (comma, offset, text) { return text.indexOf(".") < 0 ? "." : ""; })
      .replace(/\s/g, "");
    if (!normalized || !/^\d+(?:\.\d+)?$/.test(normalized)) return null;
    var amount = Number(normalized);
    return isFinite(amount) ? amount : null;
  }

  function updateChangeHint() {
    var box = document.getElementById("change-amount");
    var paid = document.getElementById("paid-amount");
    var value, diff;
    if (!box || !paid) return;
    if (paid.value === "") {
      box.hidden = true;
      box.className = "payment-change-row";
      box.textContent = "";
      return;
    }
    value = parseLocalizedAmount(paid.value);
    if (value === null || value < 0) {
      box.hidden = false;
      box.className = "payment-change-row error";
      box.textContent = "أدخل مبلغًا صالحًا";
      return;
    }
    diff = Math.round((value - (Number(cartTotal) || 0)) * 100) / 100;
    box.hidden = false;
    if (diff < -0.004) {
      box.className = "payment-change-row error";
      box.textContent = "نقص " + money(Math.abs(diff)) + " ج.م";
    } else if (diff > 0.004) {
      box.className = "payment-change-row success";
      box.textContent = "الباقي " + money(diff) + " ج.م";
    } else {
      box.className = "payment-change-row success";
      box.textContent = "المبلغ مطابق للإجمالي";
    }
  }

  function resetPaymentPanel() {
    var paid = document.getElementById("paid-amount");
    if (paid) paid.value = "";
    updateChangeHint();
  }

  function openReceiptPreview(orderId) {
    var modal = document.getElementById("receipt-preview-modal");
    var frame = document.getElementById("receipt-preview-frame");
    if (!modal || !frame) return;
    frame.setAttribute("data-order", String(orderId));
    frame.src = "/api/print-receipt/" + encodeURIComponent(orderId) + "?preview=1";
    modal.style.display = "flex";
  }

  function closeReceiptPreview() {
    var modal = document.getElementById("receipt-preview-modal");
    var frame = document.getElementById("receipt-preview-frame");
    // Clearing data-order first keeps the about:blank load event from printing.
    if (frame) {
      frame.setAttribute("data-order", "");
      frame.src = "about:blank";
    }
    if (modal) modal.style.display = "none";
  }

  function printReceiptPreview() {
    var frame = document.getElementById("receipt-preview-frame");
    if (!frame || !frame.getAttribute("data-order")) {
      showMessage("لا توجد فاتورة مفتوحة للطباعة.", "error");
      return;
    }
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (error) {
      if (window.console) console.error(error);
      showMessage("تعذر فتح نافذة الطباعة؛ جرّب زر الطباعة داخل المعاينة.", "error");
    }
  }

  var paidAmountInput = document.getElementById("paid-amount");
  if (paidAmountInput) paidAmountInput.addEventListener("input", updateChangeHint);

  var receiptPreviewModal = document.getElementById("receipt-preview-modal");
  if (receiptPreviewModal) {
    receiptPreviewModal.addEventListener("click", function (event) {
      if (event.target === receiptPreviewModal) closeReceiptPreview();
    });
  }

  ["receipt-preview-close", "receipt-preview-cancel"].forEach(function (elementId) {
    var button = document.getElementById(elementId);
    if (button) button.addEventListener("click", closeReceiptPreview);
  });

  var receiptPrintButton = document.getElementById("receipt-preview-print");
  if (receiptPrintButton) receiptPrintButton.addEventListener("click", printReceiptPreview);

  var receiptPreviewFrame = document.getElementById("receipt-preview-frame");
  if (receiptPreviewFrame) {

    receiptPreviewFrame.addEventListener("load", function () {
      // Auto print only after the preview has painted, and never for a blank frame.
      if (!receiptAutoPrint) return;
      if (!receiptPreviewFrame.getAttribute("data-order")) return;
      if (receiptPreviewFrame.getAttribute("src") === "about:blank") return;
      setTimeout(printReceiptPreview, 400);
    });
  }

  // ==========================================
  // GOODS INTAKE SCREEN (Batch 5)
  // ==========================================
  function setIntakeMessage(text, success) {
    var target = document.getElementById("cashier-intake-message");
    if (!target) return;
    target.textContent = text || "";
    target.className = "form-message field-wide" + (success ? " success" : " error");
  }

  function isFractionalUnit(unit) {
    if (!unit) return false;
    var u = String(unit).trim().toLowerCase();
    return u === "g" || u === "kg" || u === "ml" || u === "l" ||
           u === "جرام" || u === "كجم" || u === "مل" || u === "لتر" ||
           u === "غرام" || u === "كيلو" || u === "ملي" || u === "مليلتر";
  }

  function intakeQuantityStep(item) {
    if (!item) return "1";
    if (typeof item === "string") {
      return item === "material" ? "0.001" : "1";
    }
    return (item.kind === "material" || isFractionalUnit(item.unit)) ? "0.001" : "1";
  }

  function intakeTotal() {
    var i;
    var total = 0;
    for (i = 0; i < intakeLines.length; i += 1) total += Number(intakeLines[i].line_total) || 0;
    return Math.round(total * 100) / 100;
  }

  function renderIntakeLines() {
    var container = document.getElementById("cint-lines");
    var amountField = document.getElementById("cint-amount");
    var total;
    if (!container) return;
    if (!intakeLines.length) {
      container.innerHTML = '<p class="muted">لم تُضف أصناف بعد.</p>';
      if (amountField) amountField.value = "0";
      return;
    }
    total = intakeTotal();
    container.innerHTML = intakeLines.map(function (line, index) {
      return '<div class="intake-line-row">' +
        '<span class="stock-kind-badge">' + escapeHtml(line.kind_label) + '</span>' +
        '<strong>' + escapeHtml(line.name) + '</strong>' +
        '<span>' + money(line.quantity) + ' ' + escapeHtml(line.unit || "") + '</span>' +
        '<span>× ' + money(line.unit_cost) + '</span>' +
        '<span dir="ltr">' + money(line.line_total) + ' ج.م</span>' +
        '<button type="button" class="button button-danger small-btn" data-intake-remove="' + index + '">إزالة</button>' +
        '</div>';
    }).join("") + '<div class="intake-summary">الإجمالي ' + money(total) + ' ج.م · ' + intakeLines.length + ' صنف</div>';
    if (amountField) amountField.value = String(total);
  }

  function renderIntakeSuggestions(rows) {
    var target = document.getElementById("cint-suggestions");
    if (!target) return;
    intakeSuggestions = rows || [];
    if (!intakeSuggestions.length) {
      target.hidden = true;
      target.innerHTML = "";
      return;
    }
    target.hidden = false;
    target.innerHTML = intakeSuggestions.map(function (row, index) {
      return '<button type="button" class="stock-suggestion" data-intake-index="' + index + '">' +
        '<span class="stock-kind-badge">' + escapeHtml(row.kind_label) + '</span>' +
        escapeHtml(row.name) +
        '<small>' + escapeHtml(row.unit || "") + ' · مخزون ' +
        (row.stock === null ? "غير متتبع" : money(row.stock)) + '</small>' +
        '</button>';
    }).join("");
  }

  function pickIntakeItem(item) {
    var quantityInput = document.getElementById("cint-quantity");
    var costInput = document.getElementById("cint-cost");
    var searchInput = document.getElementById("cint-search");
    intakePicked = item;
    renderIntakeSuggestions([]);
    if (searchInput) searchInput.value = item.name;
    if (quantityInput) {
      quantityInput.setAttribute("step", intakeQuantityStep(item));
      if (!Number(quantityInput.value)) quantityInput.value = "1";
    }
    if (costInput) costInput.value = (item.unit_cost && Number(item.unit_cost) > 0) ? String(item.unit_cost) : "";
    setIntakeMessage("الصنف المختار: " + item.name + " (" + (item.unit || "قطعة") + ") — حدد الكمية وتكلفة الوحدة ثم اضغط إضافة.", true);
  }

  function addIntakeLine() {
    var quantityInput = document.getElementById("cint-quantity");
    var costInput = document.getElementById("cint-cost");
    var searchField = document.getElementById("cint-search");
    var quantity, unitCost, existing, i, line;
    if (!intakePicked) {
      setIntakeMessage("اختر الصنف من قائمة الاقتراحات أولًا.", false);
      return;
    }
    quantity = Number(quantityInput ? quantityInput.value : 0);
    if (!(quantity > 0)) {
      setIntakeMessage("الكمية يجب أن تكون أكبر من صفر.", false);
      return;
    }
    var allowDecimal = intakePicked.kind === "material" || isFractionalUnit(intakePicked.unit);
    if (!allowDecimal && quantity % 1 !== 0) {
      setIntakeMessage("كمية هذا الصنف يجب أن تكون عددًا صحيحًا.", false);
      return;
    }
    if (!costInput || costInput.value.trim() === "") {
      setIntakeMessage("تكلفة الوحدة مطلوبة للصنف.", false);
      if (costInput) costInput.focus();
      return;
    }
    unitCost = Number(costInput.value);
    if (!isFinite(unitCost) || unitCost <= 0) {
      setIntakeMessage("تكلفة الوحدة يجب أن تكون رقمًا أكبر من صفر.", false);
      if (costInput) costInput.focus();
      return;
    }
    unitCost = Math.round(unitCost * 100) / 100;
    for (i = 0; i < intakeLines.length; i += 1) {
      existing = intakeLines[i];
      if (existing.kind === intakePicked.kind && Number(existing.id) === Number(intakePicked.id)) {
        existing.quantity = Math.round((existing.quantity + quantity) * 1000) / 1000;
        existing.unit_cost = unitCost;
        existing.line_total = Math.round(existing.quantity * unitCost * 100) / 100;
        renderIntakeLines();
        intakePicked = null;
        if (searchField) searchField.value = "";
        if (costInput) costInput.value = "";
        if (quantityInput) quantityInput.value = "1";
        setIntakeMessage("تم تحديث كمية " + existing.name + ".", true);
        return;
      }
    }
    line = {
      kind: intakePicked.kind,
      kind_label: intakePicked.kind_label,
      id: Number(intakePicked.id),
      name: intakePicked.name,
      unit: intakePicked.unit || "",
      quantity: quantity,
      unit_cost: unitCost,
      line_total: Math.round(quantity * unitCost * 100) / 100
    };
    intakeLines.push(line);
    renderIntakeLines();
    intakePicked = null;
    if (searchField) searchField.value = "";
    if (costInput) costInput.value = "";
    if (quantityInput) quantityInput.value = "1";
    setIntakeMessage("أضيف " + line.name + " إلى قائمة التسجيل.", true);
  }

  function loadCashierIntake() {
    var body = document.getElementById("cashier-intake-body");
    var dateInput = document.getElementById("cint-date");
    if (!body) return;
    bindCashierIntake();
    if (dateInput && !dateInput.value) dateInput.value = todayIso();
    body.innerHTML = '<p class="muted">جارٍ تحميل البضاعة المسجلة...</p>';
    requestJson("/api/purchases?date=" + encodeURIComponent(todayIso()), null, function (error, rows) {
      if (error) {
        body.innerHTML = '<p class="form-message error">' + escapeHtml(error.message) + '</p>';
        return;
      }
      if (!rows.length) {
        body.innerHTML = '<p class="empty-table">لا توجد بضاعة مسجلة اليوم.</p>';
        return;
      }
      body.innerHTML =
        '<table><thead><tr><th>الوقت</th><th>المورّد</th><th>الأصناف</th><th>الإجمالي</th>' +
        '<th>الدرج</th><th>بواسطة</th><th>إجراء</th></tr></thead><tbody>' +
        rows.map(function (row) {
          var names = (row.items || []).map(function (line) {
            return line.name + " (" + money(line.quantity) + " " + (line.unit || "") + ")";
          }).join("، ") || row.category || "—";
          return '<tr><td>' + escapeHtml(formatDateTime(row.timestamp)) + '</td>' +
            '<td>' + escapeHtml(row.supplier || "—") + '</td>' +
            '<td>' + escapeHtml(names) + (row.note ? '<div class="muted small">' + escapeHtml(row.note) + '</div>' : "") + '</td>' +
            '<td dir="ltr">' + money(row.amount) + '</td>' +
            '<td>' + (row.expense_id ? "خُصم من الدرج" : "بدون خصم") + '</td>' +
            '<td>' + escapeHtml(row.employee_name || "—") + '</td>' +
            '<td><button type="button" class="button button-danger small-btn" data-intake-delete="' +
            Number(row.id) + '">حذف</button></td></tr>';
        }).join("") +
        '</tbody></table>';
    });
  }

  function bindCashierIntake() {
    var searchInput = document.getElementById("cint-search");
    var suggestions = document.getElementById("cint-suggestions");
    var addButton = document.getElementById("cint-add-line");
    var linesBox = document.getElementById("cint-lines");
    var amountField = document.getElementById("cint-amount");
    var form = document.getElementById("cashier-intake-form");
    var body = document.getElementById("cashier-intake-body");
    var refreshButton = document.getElementById("refresh-intake");
    if (intakeBound) return;
    intakeBound = true;
    if (refreshButton) refreshButton.addEventListener("click", loadCashierIntake);
    if (searchInput && suggestions) {
      searchInput.addEventListener("input", function () {
        var query = searchInput.value.trim();
        intakePicked = null;
        if (intakeSearchTimer) clearTimeout(intakeSearchTimer);
        if (query.length < 2) {
          renderIntakeSuggestions([]);
          return;
        }
        intakeSearchTimer = setTimeout(function () {
          requestJson("/api/stock-suggestions?q=" + encodeURIComponent(query), null, function (error, rows) {
            renderIntakeSuggestions(error ? [] : rows.slice(0, 10));
          });
        }, 250);
      });
      suggestions.addEventListener("click", function (event) {
        var button = findDataElement(event.target, "data-intake-index", suggestions);
        if (!button) return;
        pickIntakeItem(intakeSuggestions[Number(button.getAttribute("data-intake-index"))]);
      });
    }
    if (addButton) addButton.addEventListener("click", addIntakeLine);
    if (linesBox) {
      linesBox.addEventListener("click", function (event) {
        var button = findDataElement(event.target, "data-intake-remove", linesBox);
        if (!button) return;
        intakeLines.splice(Number(button.getAttribute("data-intake-remove")), 1);
        renderIntakeLines();
      });
    }
    if (form) {
      form.addEventListener("submit", function (event) {
        var payload;
        var submitButton = form.querySelector("button[type=\"submit\"]");
        event.preventDefault();
        if (!intakeLines.length) {
          setIntakeMessage("أضف صنفًا واحدًا على الأقل قبل التسجيل.", false);
          return;
        }
        for (var idx = 0; idx < intakeLines.length; idx += 1) {
          if (!isFinite(intakeLines[idx].unit_cost) || intakeLines[idx].unit_cost <= 0) {
            setIntakeMessage("تكلفة الوحدة مطلوبة وإجبارية للصنف: " + intakeLines[idx].name, false);
            return;
          }
        }
        payload = {
          date: document.getElementById("cint-date") ? document.getElementById("cint-date").value : todayIso(),
          supplier: document.getElementById("cint-supplier") ? document.getElementById("cint-supplier").value.trim() : "",
          note: document.getElementById("cint-note") ? document.getElementById("cint-note").value.trim() : "",
          items: intakeLines.map(function (line) {
            return {kind: line.kind, id: line.id, quantity: line.quantity, unit_cost: line.unit_cost};
          }),
          amount: intakeTotal(),
          paid_from_drawer: !!(document.getElementById("cint-drawer") && document.getElementById("cint-drawer").checked)
        };
        if (!payload.date) {
          setIntakeMessage("التاريخ مطلوب لتسجيل البضاعة.", false);
          return;
        }
        if (submitButton) submitButton.disabled = true;
        requestJson("/api/purchases", {method: "POST", body: JSON.stringify(payload)}, function (error, result) {
          if (submitButton) submitButton.disabled = false;
          if (error) {
            setIntakeMessage(error.message, false);
            return;
          }
          setIntakeMessage("تم تسجيل " + intakeLines.length + " صنف ورفع مخزونها · الرقم " +
            result.id + (payload.paid_from_drawer ? " وخُصمت " + money(result.amount) + " من الدرج." : " دون خصم من الدرج."), true);
          intakeLines = [];
          intakePicked = null;
          intakeAmountTouched = false;
          renderIntakeLines();
          form.reset();
          var dateEl = document.getElementById("cint-date");
          if (dateEl) dateEl.value = todayIso();
          var qtyEl = document.getElementById("cint-quantity");
          if (qtyEl) qtyEl.value = "1";
          var costEl = document.getElementById("cint-cost");
          if (costEl) costEl.value = "";
          var noteEl = document.getElementById("cint-note");
          if (noteEl) noteEl.value = "";
          if (amountField) amountField.value = "0";
          loadCashierIntake();
          loadProducts();
          loadCashierDrawer();
          loadCashierClosing();
        });
      });
    }
    if (body) {
      body.addEventListener("click", function (event) {
        var button = findDataElement(event.target, "data-intake-delete", body);
        if (!button) return;
        var purchaseId = button.getAttribute("data-intake-delete");
        if (!window.confirm("تأكيد حذف تسجيل البضاعة رقم " + purchaseId + "؟ سيُخصم العدد من المخزون.")) return;
        requestJson("/api/purchases/" + purchaseId, {method: "DELETE"}, function (error) {
          if (error) {
            setIntakeMessage(error.message, false);
            return;
          }
          setIntakeMessage("تم حذف التسجيل وإرجاع المخزون لوضعه السابق.", true);
          loadCashierIntake();
          loadProducts();
          loadCashierDrawer();
          loadCashierClosing();
        });
      });
    }
  }

  // ==========================================
  // EXPENSE → STOCK SUGGESTIONS (cashier side)
  // ==========================================
  function renderCashierExpenseStock() {
    var target = document.getElementById("cexp-stock-selected");
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
      '<span class="muted">المخزون الحالي ' +
      (expenseStockItem.stock === null ? "غير متتبع" : money(expenseStockItem.stock) + " " + escapeHtml(expenseStockItem.unit || "")) +
      '</span></div>' +
      '<div class="stock-selected-fields">' +
      '<label for="cexp-stock-qty">الكمية المضافة</label>' +
      '<input id="cexp-stock-qty" type="number" min="0" step="' + intakeQuantityStep(expenseStockItem.kind) + '" value="1">' +
      '<label for="cexp-stock-cost">تكلفة الوحدة</label>' +
      '<input id="cexp-stock-cost" type="number" min="0" step="0.01" value="' + money(expenseStockItem.unit_cost) + '">' +
      '<button type="button" class="button button-secondary" id="cexp-stock-clear">إلغاء الربط</button>' +
      '</div>';
    var clearButton = document.getElementById("cexp-stock-clear");
    if (clearButton) {
      clearButton.addEventListener("click", function () {
        expenseStockItem = null;
        renderCashierExpenseStock();
      });
    }
  }

  function showCashierExpenseSuggestions(rows) {
    var target = document.getElementById("cexp-suggestions");
    if (!target) return;
    expenseSuggestions = rows || [];
    if (!expenseSuggestions.length) {
      target.hidden = true;
      target.innerHTML = "";
      return;
    }
    target.hidden = false;
    target.innerHTML = expenseSuggestions.map(function (row, index) {
      return '<button type="button" class="stock-suggestion" data-cexp-stock-index="' + index + '">' +
        '<span class="stock-kind-badge">' + escapeHtml(row.kind_label) + '</span>' +
        escapeHtml(row.name) +
        '<small>' + escapeHtml(row.unit || "") + ' · مخزون ' +
        (row.stock === null ? "—" : money(row.stock)) + '</small>' +
        '</button>';
    }).join("");
  }

  function bindCashierExpenseStock() {
    var categoryInput = document.getElementById("cexp-category");
    var container = document.getElementById("cexp-suggestions");
    if (expenseStockBound) return;
    if (!categoryInput || !container) return;
    expenseStockBound = true;
    categoryInput.addEventListener("input", function () {
      var query = categoryInput.value.trim();
      if (expenseSuggestionTimer) clearTimeout(expenseSuggestionTimer);
      if (query.length < 2) {
        showCashierExpenseSuggestions([]);
        return;
      }
      expenseSuggestionTimer = setTimeout(function () {
        requestJson("/api/stock-suggestions?q=" + encodeURIComponent(query), null, function (error, rows) {
          showCashierExpenseSuggestions(error ? [] : rows.slice(0, 8));
        });
      }, 250);
    });
    container.addEventListener("click", function (event) {
      var button = findDataElement(event.target, "data-cexp-stock-index", container);
      if (!button) return;
      expenseStockItem = expenseSuggestions[Number(button.getAttribute("data-cexp-stock-index"))];
      if (!expenseStockItem) return;
      showCashierExpenseSuggestions([]);
      renderCashierExpenseStock();
    });
  }

  function expenseStockPayload() {
    var qtyInput = document.getElementById("cexp-stock-qty");
    var costInput = document.getElementById("cexp-stock-cost");
    var quantity;
    if (!expenseStockItem || !qtyInput) return null;
    if (!expenseStockItem.affects_stock) return null;
    quantity = Number(qtyInput.value || 0);
    if (!(quantity > 0)) return null;
    return {
      kind: expenseStockItem.kind,
      id: expenseStockItem.id,
      name: expenseStockItem.name,
      quantity: quantity,
      unit_cost: costInput && costInput.value !== "" ? Number(costInput.value) : Number(expenseStockItem.unit_cost || 0)
    };
  }

  // ==========================================
  // DAY CLOSING (cashier side)
  // ==========================================
  function closingMetricCard(label, value) {
    return '<div class="metric-card"><span>' + label + '</span><strong dir="ltr">' + value + '</strong></div>';
  }

  function loadCashierClosing() {
    var body = document.getElementById("cashier-closing-body");
    if (!body) return;
    bindCashierClosing();
    body.innerHTML = '<p class="muted">جارٍ تحميل بيانات اليوم...</p>';
    requestJson("/api/closing/state", null, function (error, state) {
      var day, sealed, reports;
      if (error) {
        body.innerHTML = '<p class="form-message error">' + escapeHtml(error.message) + '</p>';
        return;
      }
      day = state.day_summary || {};
      sealed = state.day_closing;
      reports = (state.reports || []).slice(0, 10);
      body.innerHTML =
        '<div class="metric-grid">' +
        closingMetricCard("مبيعات اليوم", money(day.sales)) +
        closingMetricCard("عدد الفواتير", String(Number(day.orders_count || 0))) +
        closingMetricCard("مصروفات اليوم", money(day.expenses)) +
        closingMetricCard("رصيد الدرج المتوقع", money(day.drawer_balance)) +
        '</div>' +
        (sealed
          ? '<p class="closing-status closed">تم تقفيل يوم ' + escapeHtml(formatDateOnly(state.today)) +
            ' · المعدود ' + money(sealed.counted_cash) + ' · الفرق ' + money(sealed.closing_variance) +
            (sealed.closed_by ? ' بواسطة ' + escapeHtml(sealed.closed_by) : "") + '.</p>'
          : '<p class="closing-status">اليوم ما زال مفتوحًا؛ التقفيل يخزّن تقرير اليوم ويبدأ يومًا جديدًا بالرصيد المعدود.</p>') +
        (sealed ? "" :
          '<div class="admin-form">' +
          '<div class="field"><label for="cclosing-counted">رصيد الدرج المعدود</label>' +
          '<input id="cclosing-counted" type="number" min="0" step="0.01" value="' + Number(day.drawer_balance || 0) + '"></div>' +
          '<div class="field"><label for="cclosing-note">ملاحظة (اختياري)</label>' +
          '<input id="cclosing-note" type="text" maxlength="300"></div>' +
          '<div class="field form-actions"><button type="button" class="button button-danger" id="cashier-closing-run">تقفيل اليوم الآن</button></div>' +
          '</div>') +
        '<h3>آخر التقارير المقفلة</h3>' +
        '<table><thead><tr><th>الفترة</th><th>النوع</th><th>المتوقع</th><th>المعدود</th><th>الفرق</th><th>بواسطة</th><th>إجراء</th></tr></thead><tbody>' +
        (reports.map(function (report) {
          return '<tr><td>' + escapeHtml(report.period_type === "month" ? report.period_key : formatDateOnly(report.period_key)) +
            '</td><td>' + (report.period_type === "month" ? (report.auto_generated ? "شهر (تلقائي)" : "شهر") : "يوم") +
            '</td><td dir="ltr">' + money(report.expected_cash) +
            '</td><td dir="ltr">' + money(report.counted_cash) +
            '</td><td dir="ltr">' + money(report.closing_variance) +
            '</td><td>' + escapeHtml(report.closed_by || "—") + '</td>' +
            '<td>' + (report.period_type === "day"
              ? '<button type="button" class="button button-secondary small-btn" data-reopen-day="' +
                escapeHtml(report.period_key) + '">إعادة فتح</button>'
              : "—") + '</td></tr>';
        }).join("") || '<tr><td colspan="7">لا توجد تقارير مقفلة بعد.</td></tr>') +
        '</tbody></table>' +
        ((state.pending_months || []).length
          ? '<p class="muted small">أشهر بانتظار التقفيل التلقائي: ' + escapeHtml(state.pending_months.join("، ")) + '</p>'
          : "");
      var runButton = document.getElementById("cashier-closing-run");
      if (runButton) runButton.addEventListener("click", runCashierDayClose);
    });
  }

  function runCashierDayClose() {
    var countedInput = document.getElementById("cclosing-counted");
    var noteInput = document.getElementById("cclosing-note");
    var counted = countedInput ? countedInput.value : "";
    if (counted === "" || Number(counted) < 0) {
      setExpenseMessage("أدخل رصيد الدرج المعدود قبل التقفيل.", false);
      return;
    }
    if (!window.confirm("تقفيل يوم " + todayIso() + "؟ سيتم تخزين تقرير اليوم وإغلاق الوردية وفتح يوم جديد.")) return;
    requestJson("/api/day-close", {
      method: "POST",
      body: JSON.stringify({date: todayIso(), counted_cash: counted, note: noteInput ? noteInput.value.trim() : ""})
    }, function (error, result) {
      if (error) {
        setExpenseMessage(error.message, false);
        return;
      }
      setExpenseMessage("تم تقفيل اليوم · الفرق " + money(result.closing_variance) +
        (result.next_day ? " · بدأ يوم " + result.next_day : ""), true);
      loadCashierClosing();
      loadCashierExpenses();
      loadCashierDrawer();
      loadTodaySales();
    });
  }

  function bindCashierClosing() {
    var refreshButton = document.getElementById("refresh-closing");
    var body = document.getElementById("cashier-closing-body");
    if (closingBound) return;
    closingBound = true;
    if (refreshButton) refreshButton.addEventListener("click", loadCashierClosing);
    if (body) {
      body.addEventListener("click", function (event) {
        var button = findDataElement(event.target, "data-reopen-day", body);
        if (!button) return;
        var day = button.getAttribute("data-reopen-day");
        if (!window.confirm("إعادة فتح يوم " + day + "؟ سيُحذف التقرير المقفل.")) return;
        requestJson("/api/closing/reopen", {
          method: "POST",
          body: JSON.stringify({period: "day", date: day})
        }, function (error) {
          if (error) {
            setExpenseMessage(error.message, false);
            return;
          }
          setExpenseMessage("تم إعادة فتح اليوم.", true);
          loadCashierClosing();
          loadCashierExpenses();
        });
      });
    }
  }

  bindCashierGlobalSearch();
  initCategoryTabs();
  setCashierView("pos");
  window.addEventListener("focus", loadProducts);
  window.addEventListener("focus", loadCashierNotifications);
  loadProducts();
  loadTodaySales();
  loadCashierNotifications();
  loadEmployeeState();
  loadCashierDrawer();
  if (window.BroadcastChannel) {
    var catalogChannel = new BroadcastChannel("bookmart-catalog");
    catalogChannel.addEventListener("message", function (event) {
      if (event.data && event.data.type === "catalog-updated") {
        loadProducts();
        loadTodaySales();
        loadCashierNotifications();
      }
    });
  }
}());
