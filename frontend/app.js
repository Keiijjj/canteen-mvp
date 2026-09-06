const BASE_URL = window.location.origin + "/api";
const DEPOSITS = { plate: 10.0, cutlery: 5.0 };

let currentUserId = 4; // Default to Student A
let allUsers = [];
let menuData = [];
let cart = [];

// Local tableware counters for student cart
let borrowedPlates = 0;
let borrowedCutlery = 0;

let html5QrScanner = null;
let queuePollingInterval = null;

// Kitchen / Admin Audio State
let audioCtx = null;
let kitchenAlarmInterval = null;
let seenOrderIds = new Set(); // Tracks orders to sound chime only on new ones
let currentQueueTab = "all";
let rawQueueData = [];

// DOM References
const userSelect = document.getElementById("userSelect");
const walletBalanceEl = document.getElementById("walletBalance");
const borrowedPlatesEl = document.getElementById("borrowedPlates");
const borrowedCutleryEl = document.getElementById("borrowedCutlery");
const walletStatBox = document.getElementById("walletStatBox");
const borrowedStatBox = document.getElementById("borrowedStatBox");
const cartSidebar = document.getElementById("cartSidebar");
const menuGrid = document.getElementById("menuGrid");

const showDepositQrBtn = document.getElementById("showDepositQrBtn");
const showReturnQrBtn = document.getElementById("showReturnQrBtn");
const openScannerBtn = document.getElementById("openScannerBtn");

const qrModal = document.getElementById("qrModal");
const qrModalTitle = document.getElementById("qrModalTitle");
const qrModalDesc = document.getElementById("qrModalDesc");
const qrcodeBox = document.getElementById("qrcodeBox");
const scannerModal = document.getElementById("scannerModal");

const cartItemsContainer = document.getElementById("cartItems");
const subtotalEl = document.getElementById("subtotalAmount");
const depositEl = document.getElementById("depositAmount");
const totalEl = document.getElementById("totalAmount");
const checkoutBtn = document.getElementById("checkoutBtn");
const plateCountEl = document.getElementById("plateCount");
const cutleryCountEl = document.getElementById("cutleryCount");
const utensilSection = document.getElementById("utensilSection");

// Panels
const adminLoansPanel = document.getElementById("admin-loans-panel");
const adminQueuePanel = document.getElementById("admin-queue-panel");
const studentOrdersPanel = document.getElementById("student-orders-panel");

// Unlock Web Audio API on first interaction (Admin/Kitchen device)
function initAudioEngine() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}
window.addEventListener("click", initAudioEngine);
window.addEventListener("touchstart", initAudioEngine);

// Kitchen Beep: Short, distinct alert (Plays ONLY for Super Admin & Kitchen)
function playKitchenChime() {
  const currentUser = allUsers.find(u => u.id === currentUserId);
  if (!currentUser || (currentUser.role !== "super_admin" && currentUser.role !== "kitchen")) {
    return; // Strictly block playback on Student & Cashier devices
  }

  try {
    initAudioEngine();
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, now); // D5 note
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.15); // Slide to A5

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(now);
    osc.stop(now + 0.35);
  } catch (e) {
    console.warn("Audio chime prevented:", e);
  }
}

// Silence and reset any audio loop
function stopAllAlarms() {
  if (kitchenAlarmInterval) {
    clearInterval(kitchenAlarmInterval);
    kitchenAlarmInterval = null;
  }
}

// Initialize Users
async function initUsers() {
  try {
    const res = await fetch(`${BASE_URL}/users`);
    allUsers = await res.json();

    userSelect.innerHTML = "";
    allUsers.forEach(u => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = `${u.name} (${u.role.toUpperCase()})`;
      if (u.id === currentUserId) opt.selected = true;
      userSelect.appendChild(opt);
    });

    switchUser(currentUserId);
  } catch (err) {
    console.error("User initialization failed:", err);
  }
}

// Role Switcher & Strict UI Isolation
function switchUser(userId) {
  stopAllAlarms(); // Hard kill any ongoing sounds immediately

  currentUserId = parseInt(userId);
  const user = allUsers.find(u => u.id === currentUserId);
  if (!user) return;

  // 1. Force-hide all dynamic panels first using !important to override inline styling
  if (adminLoansPanel) adminLoansPanel.style.setProperty("display", "none", "important");
  if (adminQueuePanel) adminQueuePanel.style.setProperty("display", "none", "important");
  if (studentOrdersPanel) studentOrdersPanel.style.setProperty("display", "none", "important");

  // Reset student and header controls
  if (cartSidebar) cartSidebar.style.display = "none";
  if (walletStatBox) walletStatBox.style.display = "none";
  if (borrowedStatBox) borrowedStatBox.style.display = "none";
  if (showDepositQrBtn) showDepositQrBtn.style.display = "none";
  if (showReturnQrBtn) showReturnQrBtn.style.display = "none";
  if (openScannerBtn) openScannerBtn.style.display = "none";

  // 2. Configure View According to Strict Role
  if (user.role === "super_admin") {
    if (openScannerBtn) {
      openScannerBtn.style.display = "inline-block";
      openScannerBtn.textContent = "📷 Scan QR (Deposit / Return)";
    }
    if (adminLoansPanel) adminLoansPanel.style.setProperty("display", "block", "important");
    if (adminQueuePanel) adminQueuePanel.style.setProperty("display", "block", "important");
    loadActiveLoans();
    fetchOrderQueue();

  } else if (user.role === "cashier") {
    if (openScannerBtn) {
      openScannerBtn.style.display = "inline-block";
      openScannerBtn.textContent = "📷 Scan QR (Deposit / Return)";
    }
    if (adminLoansPanel) adminLoansPanel.style.setProperty("display", "block", "important");
    loadActiveLoans();

  } else if (user.role === "kitchen") {
    if (adminQueuePanel) adminQueuePanel.style.setProperty("display", "block", "important");
    fetchOrderQueue();
    
  } else if (user.role === "cashier") {
    if (openScannerBtn) {
      openScannerBtn.style.display = "inline-block";
      openScannerBtn.textContent = "📷 Scan QR (Deposit / Return)";
    }
    if (adminLoansPanel) adminLoansPanel.style.setProperty("display", "block", "important");
    if (adminQueuePanel) adminQueuePanel.style.setProperty("display", "block", "important"); // <--- Cashier can now see the queue & rush notes
    loadActiveLoans();
    fetchOrderQueue();  

  } else {
    // STUDENT VIEW: Loans panel remains strictly hidden
    if (cartSidebar) cartSidebar.style.display = "block";
    if (walletStatBox) walletStatBox.style.display = "block";
    if (borrowedStatBox) borrowedStatBox.style.display = "block";
    if (showDepositQrBtn) showDepositQrBtn.style.display = "inline-block";
    if (showReturnQrBtn) showReturnQrBtn.style.display = "inline-block";
    if (studentOrdersPanel) studentOrdersPanel.style.setProperty("display", "block", "important");

    syncUserStats();
    fetchStudentOrders();
  }

  renderMenu(menuData);
}

// Sync Student's Personal Wallet and Personal Tableware Count ONLY
async function syncUserStats() {
  try {
    const res = await fetch(`${BASE_URL}/users/${currentUserId}`);
    const user = await res.json();
    if (walletBalanceEl) walletBalanceEl.textContent = `₱${user.balance.toFixed(2)}`;
    if (borrowedPlatesEl) borrowedPlatesEl.textContent = user.borrowed_plates;
    if (borrowedCutleryEl) borrowedCutleryEl.textContent = user.borrowed_cutlery;
  } catch (err) {
    console.error("Could not sync user stats:", err);
  }
}

// Fetch & Render Menu
async function fetchMenu() {
  try {
    const res = await fetch(`${BASE_URL}/menu`);
    menuData = await res.json();
    renderMenu(menuData);
  } catch (err) {
    if (menuGrid) menuGrid.innerHTML = `<p style="color:red;">Error loading dishes.</p>`;
  }
}

function renderMenu(items) {
  if (!menuGrid) return;
  menuGrid.innerHTML = "";
  if (!items || items.length === 0) {
    menuGrid.innerHTML = "<p>No dishes found in this category.</p>";
    return;
  }

  // Helper to normalize status strings
  const getStatus = (dish) => {
    return (typeof dish.stock_status === "string" 
      ? dish.stock_status 
      : (dish.stock_status?.value || "available")).toLowerCase();
  };

  // Sort available/limited dishes first, sold-out items to the bottom
  const sortedItems = [...items].sort((a, b) => {
    const aSoldOut = getStatus(a) === "sold_out";
    const bSoldOut = getStatus(b) === "sold_out";
    return aSoldOut === bSoldOut ? 0 : aSoldOut ? 1 : -1;
  });

  const currentUser = allUsers.find(u => u.id === currentUserId);
  const canManageStock = currentUser && (currentUser.role === "super_admin" || currentUser.role === "kitchen");

  sortedItems.forEach(dish => {
    const card = document.createElement("div");
    const rawStatus = getStatus(dish);
    const isSoldOut = rawStatus === "sold_out";

    card.className = `card ${isSoldOut ? "sold-out-card" : ""}`;
    const imgSrc = dish.description || "./images/rice.jpg";

    let badgeText = "Available";
    let badgeClass = "badge-available";
    if (rawStatus === "limited") {
      badgeText = "Limited Stock";
      badgeClass = "badge-limited";
    } else if (isSoldOut) {
      badgeText = "Sold Out";
      badgeClass = "badge-sold_out";
    }

    let footerActionHtml = "";
    if (canManageStock) {
      footerActionHtml = `
        <div class="admin-stock-control" style="border:none; padding:0; margin:0; width:100%;">
          <select class="admin-stock-select" onchange="changeStockStatus(${dish.id}, this.value)" style="width:100%; padding:6px; border-radius:6px; border:1px solid #cbd5e1; font-weight:600;">
            <option value="available" ${rawStatus === "available" ? "selected" : ""}>🟢 Available</option>
            <option value="limited" ${rawStatus === "limited" ? "selected" : ""}>🟡 Limited</option>
            <option value="sold_out" ${rawStatus === "sold_out" ? "selected" : ""}>🔴 Out of Stock</option>
          </select>
        </div>
      `;
    } else {
      footerActionHtml = `
        <button class="add-btn" onclick="addToCart(${dish.id}, event)" ${isSoldOut ? "disabled style='background:#cbd5e1; cursor:not-allowed;'" : ""}>
          ${isSoldOut ? "Sold Out" : "+ Add"}
        </button>
      `;
    }

    card.innerHTML = `
      <div class="card-image-wrapper">
        <span class="stock-badge ${badgeClass}">${badgeText}</span>
        <img src="${imgSrc}" alt="${dish.name}" class="card-img" />
      </div>
      <div class="card-body">
        <div class="card-tag">${dish.category}</div>
        <h3 class="card-title">${dish.name}</h3>
      </div>
      <div class="card-footer">
        <span class="price">₱${dish.price.toFixed(2)}</span>
        ${footerActionHtml}
      </div>
    `;
    menuGrid.appendChild(card);
  });
}
// Stock Update (Kitchen and Super Admin)
window.changeStockStatus = async function(dishId, newStatus) {
  try {
    const res = await fetch(`${BASE_URL}/admin/menu/${dishId}/stock`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_id: currentUserId, stock_status: newStatus })
    });
    if (!res.ok) throw new Error();
    const dish = menuData.find(d => d.id === dishId);
    if (dish) dish.stock_status = newStatus;
    renderMenu(menuData);
  } catch (err) {
    alert("Error updating stock status.");
  }
};

// Cart Operations
// Order Type Toggle Listener
document.querySelectorAll("input[name='orderType']").forEach(radio => {
  radio.addEventListener("change", (e) => {
    if (e.target.value === "takeout") {
      borrowedPlates = 0;
      borrowedCutlery = 0;
      if (utensilSection) utensilSection.style.display = "none";
    } else {
      if (utensilSection) utensilSection.style.display = "block";
      const hasViand = cart.some(i => i.category === "meat" || i.category === "vegetable");
      if (hasViand) {
        borrowedPlates = 1;
        borrowedCutlery = 1;
      }
    }
    updateCartUI();
  });
});

window.addToCart = function(id, evt) {
  const dish = menuData.find(i => i.id === id);
  if (!dish || dish.stock_status === "sold_out") return;

  if (evt && evt.currentTarget) {
    const btn = evt.currentTarget;
    btn.classList.remove("btn-pop");
    void btn.offsetWidth;
    btn.classList.add("btn-pop");
  }

  const orderTypeRadio = document.querySelector("input[name='orderType']:checked");
  const isDineIn = orderTypeRadio ? orderTypeRadio.value === "dine_in" : true;
  const isViand = dish.category === "meat" || dish.category === "vegetable";
  const hadViandBefore = cart.some(i => i.category === "meat" || i.category === "vegetable");

  const existing = cart.find(i => i.id === id);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ ...dish, qty: 1 });
  }

  if (isDineIn && isViand && !hadViandBefore) {
    if (borrowedPlates === 0) borrowedPlates = 1;
    if (borrowedCutlery === 0) borrowedCutlery = 1;
  }

  updateCartUI();
};

window.decreaseQty = function(id) {
  const idx = cart.findIndex(i => i.id === id);
  if (idx === -1) return;
  if (cart[idx].qty > 1) {
    cart[idx].qty -= 1;
  } else {
    cart.splice(idx, 1);
  }

  const orderTypeRadio = document.querySelector("input[name='orderType']:checked");
  const isDineIn = orderTypeRadio ? orderTypeRadio.value === "dine_in" : true;
  const hasViandsLeft = cart.some(i => i.category === "meat" || i.category === "vegetable");
  
  if (!hasViandsLeft || !isDineIn) {
    borrowedPlates = 0;
    borrowedCutlery = 0;
  }

  updateCartUI();
};

window.increaseQty = function(id) {
  const item = cart.find(i => i.id === id);
  if (item) {
    item.qty += 1;
    updateCartUI();
  }
};

window.adjustTableware = function(type, delta) {
  const orderTypeRadio = document.querySelector("input[name='orderType']:checked");
  const isDineIn = orderTypeRadio ? orderTypeRadio.value === "dine_in" : true;
  if (!isDineIn) return;

  if (type === "plate") {
    borrowedPlates = Math.max(0, borrowedPlates + delta);
  } else {
    borrowedCutlery = Math.max(0, borrowedCutlery + delta);
  }
  updateCartUI();
};

function updateCartUI() {
  if (plateCountEl) plateCountEl.textContent = borrowedPlates;
  if (cutleryCountEl) cutleryCountEl.textContent = borrowedCutlery;

  const orderTypeRadio = document.querySelector("input[name='orderType']:checked");
  const isDineIn = orderTypeRadio ? orderTypeRadio.value === "dine_in" : true;
  if (utensilSection) {
    utensilSection.style.display = isDineIn ? "block" : "none";
  }

  if (cart.length === 0) {
    if (cartItemsContainer) cartItemsContainer.innerHTML = `<p class="empty-msg">Your tray is empty.</p>`;
    if (subtotalEl) subtotalEl.textContent = "₱0.00";
    if (depositEl) depositEl.textContent = "₱0.00";
    if (totalEl) totalEl.textContent = "₱0.00";
    if (checkoutBtn) checkoutBtn.disabled = true;
    return;
  }

  if (cartItemsContainer) cartItemsContainer.innerHTML = "";
  let subtotal = 0;

  cart.forEach(item => {
    subtotal += item.price * item.qty;
    const row = document.createElement("div");
    row.className = "cart-item";
    row.innerHTML = `
      <div class="item-info">
        <div><strong>${item.name}</strong></div>
        <div>₱${(item.price * item.qty).toFixed(2)}</div>
      </div>
      <div class="qty-controls">
        <button class="qty-btn" onclick="decreaseQty(${item.id})">-</button>
        <span class="qty-val">${item.qty}</span>
        <button class="qty-btn" onclick="increaseQty(${item.id})">+</button>
      </div>
    `;
    cartItemsContainer.appendChild(row);
  });

  const depositTotal = isDineIn ? (borrowedPlates * DEPOSITS.plate) + (borrowedCutlery * DEPOSITS.cutlery) : 0;
  const grandTotal = subtotal + depositTotal;

  if (subtotalEl) subtotalEl.textContent = `₱${subtotal.toFixed(2)}`;
  if (depositEl) depositEl.textContent = `₱${depositTotal.toFixed(2)}`;
  if (totalEl) totalEl.textContent = `₱${grandTotal.toFixed(2)}`;
  if (checkoutBtn) checkoutBtn.disabled = false;
}

// Checkout
checkoutBtn.addEventListener("click", async () => {
  const selectedOrderType = document.querySelector("input[name='orderType']:checked").value;
  const payload = {
    user_id: currentUserId,
    order_type: selectedOrderType,
    cart_items: cart.map(i => ({ id: i.id, qty: i.qty })),
    plates_borrowed: borrowedPlates,
    cutlery_borrowed: borrowedCutlery
  };

  try {
    const res = await fetch(`${BASE_URL}/wallet/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return alert(`Payment Failed: ${data.detail}`);

    alert(`🎉 Order Placed!\nOrder Number: #${data.order_number}\nCharged: ₱${data.total_charged.toFixed(2)}`);
    cart = [];
    borrowedPlates = 0;
    borrowedCutlery = 0;
    updateCartUI();
    syncUserStats();
    fetchStudentOrders();
  } catch (err) {
    alert("Checkout error.");
  }
});

// Student Silent Order Tracking (No Sound)
async function fetchStudentOrders() {
  const container = document.getElementById("student-orders-list");
  if (!container) return;

  try {
    const res = await fetch(`${BASE_URL}/orders/student/${currentUserId}`);
    if (!res.ok) return;
    const orders = await res.json();

    if (orders.length === 0) {
      container.innerHTML = `<p style="color: #64748b;">No ongoing orders.</p>`;
      return;
    }

    container.innerHTML = orders.map(o => {
      let stateColor = "#f59e0b";
      let stateText = "⏳ In Queue (Waiting)";

      if (o.status === "preparing") {
        stateColor = "#3b82f6";
        stateText = "👨‍🍳 Kitchen is preparing...";
      } else if (o.status === "ready") {
        stateColor = "#10b981";
        stateText = "🛎️ Ready for Pickup at Counter!";
      }

      return `
        <div style="border-left: 5px solid ${stateColor}; background: white; padding: 12px; margin-bottom: 8px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="font-size: 1.1em; color:#0f172a;">Order #${o.order_number}</strong>
            <span style="font-weight: bold; color: ${stateColor}; font-size: 0.95em;">${stateText}</span>
          </div>
          <div style="color: #64748b; font-size: 0.9em; margin-top: 4px;">
            ${o.items.map(i => `${i.qty}x ${i.name}`).join(", ")}
          </div>
        </div>
      `;
    }).join("");
  } catch (err) {
    console.error("Error polling student orders:", err);
  }
}

// Kitchen Order Queue with Audio Chime on New Orders
window.setQueueTab = function(tab, btn) {
  currentQueueTab = tab;
  document.querySelectorAll(".queue-tab-btn").forEach(b => {
    b.style.background = "#f8fafc";
    b.style.color = "#334155";
  });
  if (btn) {
    btn.style.background = "#2563eb";
    btn.style.color = "white";
  }
  renderOrderQueue(rawQueueData);
};

async function fetchOrderQueue() {
  const tbody = document.getElementById("admin-queue-tbody");
  if (!tbody) return;

  try {
    const res = await fetch(`${BASE_URL}/orders/queue`);
    rawQueueData = await res.json();

    // Check for NEW incoming pending orders to chime for Kitchen / Super Admin
    const pendingOrders = rawQueueData.filter(o => o.status === "pending");
    let hasNewOrder = false;

    pendingOrders.forEach(o => {
      if (!seenOrderIds.has(o.order_id)) {
        seenOrderIds.add(o.order_id);
        hasNewOrder = true;
      }
    });

    // Sound chime ONLY once when new orders land on the kitchen screen
    if (hasNewOrder) {
      playKitchenChime();
    }

    // Update Tab Counters
    const counts = { all: rawQueueData.length, pending: 0, preparing: 0, ready: 0, completed: 0 };
    rawQueueData.forEach(o => {
      if (counts[o.status] !== undefined) counts[o.status]++;
    });

    const elAll = document.getElementById("count-all");
    const elPending = document.getElementById("count-pending");
    const elPrep = document.getElementById("count-preparing");
    const elReady = document.getElementById("count-ready");
    const elDone = document.getElementById("count-completed");

    if (elAll) elAll.textContent = counts.all;
    if (elPending) elPending.textContent = counts.pending;
    if (elPrep) elPrep.textContent = counts.preparing;
    if (elReady) elReady.textContent = counts.ready;
    if (elDone) elDone.textContent = counts.completed;

    renderOrderQueue(rawQueueData);
  } catch (err) {
    console.error("Queue fetch error:", err);
  }
}

function renderOrderQueue(orders) {
  const tbody = document.getElementById("admin-queue-tbody");
  if (!tbody) return;

  let filtered = orders;
  if (currentQueueTab !== "all") {
    filtered = orders.filter(o => o.status === currentQueueTab);
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 20px; color:#64748b;">No orders found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(order => {
    const itemsList = order.items.map(i => `<strong>${i.qty}x</strong> ${i.name}`).join(", ");
    let actionBtn = "";
    let statusBadge = "";

    if (order.status === "pending") {
      statusBadge = `<span style="background:#fef3c7; color:#92400e; padding:4px 8px; border-radius:4px; font-weight:bold;">⏳ Pending</span>`;
      actionBtn = `<button onclick="updateOrderStatus('${order.order_id}', 'preparing')" style="background:#3b82f6; color:white; border:none; padding:6px 12px; border-radius:5px; cursor:pointer; font-weight:600;">Start Making</button>`;
    } else if (order.status === "preparing") {
      statusBadge = `<span style="background:#dbeafe; color:#1e40af; padding:4px 8px; border-radius:4px; font-weight:bold;">👨‍🍳 In Process</span>`;
      actionBtn = `<button onclick="updateOrderStatus('${order.order_id}', 'ready')" style="background:#10b981; color:white; border:none; padding:6px 12px; border-radius:5px; cursor:pointer; font-weight:600;">Mark Ready</button>`;
    } else if (order.status === "ready") {
      statusBadge = `<span style="background:#d1fae5; color:#065f46; padding:4px 8px; border-radius:4px; font-weight:bold;">🛎️ Ready for Pickup</span>`;
      actionBtn = `<button onclick="updateOrderStatus('${order.order_id}', 'completed')" style="background:#64748b; color:white; border:none; padding:6px 12px; border-radius:5px; cursor:pointer; font-weight:600;">Complete / Picked Up</button>`;
    } else if (order.status === "completed") {
      statusBadge = `<span style="background:#f1f5f9; color:#475569; padding:4px 8px; border-radius:4px; font-weight:bold;">✅ Picked Up</span>`;
      actionBtn = `<span style="color:#94a3b8; font-size:12px; font-weight:bold;">Archived</span>`;
    }

    const currentNote = order.staff_note || "";

    return `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 10px; font-weight: 800; font-size: 1.1em;">#${order.order_number}</td>
        <td style="padding: 10px; color: #64748b; font-size: 0.9em;">${order.created_at}</td>
        <td style="padding: 10px; font-weight: 600;">${order.student_name}</td>
        <td style="padding: 10px; font-size: 0.95em;">${itemsList}</td>
        <td style="padding: 10px; text-transform: capitalize; font-size: 0.9em;">${order.order_type.replace('_', ' ')}</td>
        
        <!-- Internal Staff Note Cell -->
        <td style="padding: 6px 10px;">
          <input 
            type="text" 
            value="${currentNote.replace(/"/g, '&quot;')}" 
            placeholder="Add rush note..." 
            onchange="saveStaffNote('${order.order_id}', this.value)"
            style="width: 140px; padding: 4px 8px; font-size: 0.85em; border: 1px solid #cbd5e1; border-radius: 4px; background: #fffdf0;"
          />
        </td>

        <td style="padding: 10px;">${statusBadge}</td>
        <td style="padding: 10px;">${actionBtn}</td>
      </tr>
    `;
  }).join("");
}

window.updateOrderStatus = async function(orderId, newStatus) {
  try {
    const res = await fetch(`${BASE_URL}/admin/orders/${orderId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_id: currentUserId, status: newStatus })
    });
    if (!res.ok) throw new Error();
    fetchOrderQueue();
  } catch (err) {
    alert("Error updating order status.");
  }
};
window.saveStaffNote = async function(orderId, newNote) {
  try {
    const res = await fetch(`${BASE_URL}/admin/orders/${orderId}/note`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        admin_id: currentUserId,
        staff_note: newNote
      })
    });
    if (!res.ok) throw new Error();

    // Cache locally so active polling doesn't overwrite while typing
    const targetOrder = rawQueueData.find(o => o.order_id === orderId);
    if (targetOrder) targetOrder.staff_note = newNote;
  } catch (err) {
    alert("Failed to save note. Please check network connection.");
  }
};

// Staff Tableware Roster (Visible ONLY to Super Admin & Cashier)
async function loadActiveLoans() {
  const currentUser = allUsers.find(u => u.id === currentUserId);
  if (!currentUser || (currentUser.role !== "super_admin" && currentUser.role !== "cashier")) {
    return; // Guard rail
  }

  const tbody = document.getElementById("active-loans-tbody");
  if (!tbody) return;

  try {
    const res = await fetch(`${BASE_URL}/admin/active-loans`);
    if (!res.ok) throw new Error();
    const loans = await res.json();

    if (loans.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:15px; color:#64748b;">All tableware accounted for!</td></tr>`;
      return;
    }

    tbody.innerHTML = loans.map(student => {
      const itemBreakdown = Object.entries(student.borrowed_counts)
        .map(([name, count]) => `<span style="background:#e2e8f0; padding:2px 8px; border-radius:4px; margin-right:4px;"><strong>${count}x</strong> ${name}</span>`)
        .join(" ");

      return `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 10px;"><strong>${student.student_name}</strong></td>
          <td style="padding: 10px; color: #64748b;">#${student.student_id}</td>
          <td style="padding: 10px;">${itemBreakdown}</td>
          <td style="padding: 10px; color: #ef4444; font-weight: bold;">${student.total_unreturned} item(s)</td>
          <td style="padding: 10px;">
            <button onclick="triggerManualOverride(${student.student_id})" style="background:#ef4444; color:white; border:none; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:12px;">
              Clear Items
            </button>
          </td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    console.error("Error loading active loans:", err);
  }
}

window.triggerManualOverride = async function(studentId) {
  const confirmAction = confirm(`Clear borrowed items for student #${studentId}? Deposits will be refunded.`);
  if (!confirmAction) return;

  try {
    const res = await fetch(`${BASE_URL}/admin/manual-return-override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_id: currentUserId, student_id: studentId, refund_deposit: true })
    });
    const data = await res.json();
    if (!res.ok) return alert(`Override failed: ${data.detail}`);

    alert(data.message);
    loadActiveLoans();
  } catch (err) {
    alert("Network error processing override.");
  }
};

// QR Passes (Student Generation)
showDepositQrBtn.addEventListener("click", () => {
  qrModalTitle.textContent = "Cash Deposit Pass";
  qrModalDesc.textContent = "Show this QR to the cashier to add balance to your account.";
  const payload = JSON.stringify({ type: "deposit", token: `dep_${currentUserId}`, student_id: currentUserId });
  displayQrCode(payload);
});

showReturnQrBtn.addEventListener("click", async () => {
  const plates = parseInt(prompt("How many plates are you returning?", "1")) || 0;
  const cutlery = parseInt(prompt("How many utensil sets are you returning?", "1")) || 0;
  if (plates === 0 && cutlery === 0) return;

  try {
    const res = await fetch(`${BASE_URL}/qr/generate-return-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ student_id: currentUserId, plates, cutlery })
    });
    const data = await res.json();
    if (!res.ok) return alert(`Error: ${data.detail}`);

    qrModalTitle.textContent = "Tableware Return Pass";
    qrModalDesc.textContent = `Returning: ${plates} plate(s), ${cutlery} utensil set(s). Present to cashier.`;
    displayQrCode(JSON.stringify(data.qr_payload));
  } catch (err) {
    alert("Error creating return pass.");
  }
});

function displayQrCode(textPayload) {
  qrcodeBox.innerHTML = "";
  if (typeof QRCode === "undefined") return alert("QRCode library not loaded.");

  new QRCode(qrcodeBox, {
    text: textPayload,
    width: 200,
    height: 200,
    colorDark: "#0f172a",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
  qrModal.style.display = "flex";
}

window.closeQrModal = function() {
  qrModal.style.display = "none";
};

// Camera QR Scanner (Cashier & Super Admin)
openScannerBtn.addEventListener("click", () => {
  scannerModal.style.display = "flex";
  startScanner();
});

window.closeScannerModal = function() {
  if (html5QrScanner) {
    html5QrScanner.stop().then(() => { scannerModal.style.display = "none"; }).catch(() => { scannerModal.style.display = "none"; });
  } else {
    scannerModal.style.display = "none";
  }
};

function startScanner() {
  html5QrScanner = new Html5Qrcode("reader");
  const config = { fps: 10, qrbox: { width: 250, height: 250 } };

  html5QrScanner.start(
    { facingMode: "environment" },
    config,
    async (decodedText) => {
      await html5QrScanner.stop();
      scannerModal.style.display = "none";
      handleScannedPayload(decodedText);
    },
    () => {}
  ).catch(() => {
    alert("Camera unavailable or permission denied.");
    scannerModal.style.display = "none";
  });
}

async function handleScannedPayload(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return alert("Invalid QR Code scanned.");
  }

  if (parsed.type === "deposit") {
    const cashInput = prompt(`Student Pass Verified (ID: ${parsed.student_id}).\nEnter cash amount (₱):`, "100");
    const amount = parseFloat(cashInput);
    if (!amount || amount <= 0) return alert("Deposit canceled.");

    const res = await fetch(`${BASE_URL}/admin/process-qr-scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_id: currentUserId, action: "deposit", token: parsed.token, deposit_amount: amount })
    });
    const data = await res.json();
    if (!res.ok) return alert(`Failed: ${data.detail}`);
    alert(`✅ Deposit Successful!\n${data.message}\nNew Balance: ₱${data.new_balance.toFixed(2)}`);

  } else if (parsed.type === "return") {
    const confirmReturn = confirm(`Verify Tableware Return:\nStudent ID: ${parsed.student_id}\nPlates: ${parsed.plates}\nCutlery Sets: ${parsed.cutlery}\n\nReceive clean items?`);
    if (!confirmReturn) return alert("Return aborted.");

    const res = await fetch(`${BASE_URL}/admin/process-qr-scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_id: currentUserId, action: "return", token: parsed.token })
    });
    const data = await res.json();
    if (!res.ok) return alert(`Return failed: ${data.detail}`);
    alert(`✅ Return Accepted!\n${data.message}\nRefund Issued: +₱${data.refund_amount.toFixed(2)}`);
    loadActiveLoans();
  }
}

// Background Polling Engine
userSelect.addEventListener("change", (e) => switchUser(e.target.value));

if (queuePollingInterval) clearInterval(queuePollingInterval);
queuePollingInterval = setInterval(() => {
  const currentUser = allUsers.find(u => u.id === currentUserId);
  if (currentUser) {
    if (currentUser.role === "super_admin" || currentUser.role === "kitchen") {
      fetchOrderQueue();
    } else if (currentUser.role === "student") {
      fetchStudentOrders();
    }
  }
}, 2500);

// Initialize System
fetchMenu();
initUsers();
// --- Category Filter Setup ---
document.querySelectorAll(".filter-btn").forEach(button => {
  button.addEventListener("click", () => {
    // 1. Update active tab UI styling
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    button.classList.add("active");

    // 2. Filter menu list
    const selectedCategory = button.getAttribute("data-category");
    if (selectedCategory === "all") {
      renderMenu(menuData);
    } else {
      const filteredItems = menuData.filter(item => item.category === selectedCategory);
      renderMenu(filteredItems);
    }
  });
});