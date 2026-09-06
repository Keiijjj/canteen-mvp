import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional, Dict
from enum import Enum
import uuid
import time

app = FastAPI(title="Campus Canteen API - Multi-Role Administration")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Enums ---

class ItemCategory(str, Enum):
    MEAT = "meat"
    VEGETABLE = "vegetable"
    RICE = "rice"
    SNACK = "snack"
    DRINK = "drink"

class StockStatus(str, Enum):
    AVAILABLE = "available"
    LIMITED = "limited"
    SOLD_OUT = "sold_out"

class OrderStatus(str, Enum):
    PENDING = "pending"
    PREPARING = "preparing"
    READY = "ready"
    COMPLETED = "completed"

DEPOSIT_RATES = {
    "plate": 10.00,
    "spoon_fork_set": 5.00
}

# --- Database & Users ---

class MenuItem(BaseModel):
    id: int
    name: str
    category: ItemCategory
    price: float
    description: Optional[str] = None
    stock_status: StockStatus = StockStatus.AVAILABLE

    model_config = { "use_enum_values": True }

menu_db: List[MenuItem] = [
    MenuItem(id=1, name="Plain White Rice", category=ItemCategory.RICE, price=10.00, description="./images/rice.jpg", stock_status=StockStatus.AVAILABLE),
    MenuItem(id=2, name="Garlic Rice", category=ItemCategory.RICE, price=10.00, description="./images/garlic-rice.jpg", stock_status=StockStatus.AVAILABLE),
    MenuItem(id=3, name="Chicken Adobo", category=ItemCategory.MEAT, price=35.00, description="./images/adobo.jpg", stock_status=StockStatus.AVAILABLE),
    MenuItem(id=4, name="Pork Menudo", category=ItemCategory.MEAT, price=35.00, description="./images/menudo.jpg", stock_status=StockStatus.AVAILABLE),
    MenuItem(id=5, name="Ginisang Monggo", category=ItemCategory.VEGETABLE, price=25.00, description="./images/monggo.jpg", stock_status=StockStatus.AVAILABLE),
    MenuItem(id=6, name="Pinakbet", category=ItemCategory.VEGETABLE, price=25.00, description="./images/pinakbet.jpg", stock_status=StockStatus.AVAILABLE),
    MenuItem(id=7, name="Banana Cue", category=ItemCategory.SNACK, price=20.00, description="./images/banana-cue.jpg", stock_status=StockStatus.AVAILABLE),
    MenuItem(id=8, name="Calamansi Juice", category=ItemCategory.DRINK, price=15.00, description="./images/calamansi.jpg", stock_status=StockStatus.AVAILABLE)
]

users_db = {
    1: {"id": 1, "name": "Super Admin", "role": "super_admin", "balance": 0.0, "borrowed_plates": 0, "borrowed_cutlery": 0},
    2: {"id": 2, "name": "Cashier Desk (Deposits and Returns)", "role": "cashier", "balance": 0.0, "borrowed_plates": 0, "borrowed_cutlery": 0},
    3: {"id": 3, "name": "Kitchen Staff (Orders Only)", "role": "kitchen", "balance": 0.0, "borrowed_plates": 0, "borrowed_cutlery": 0},
    4: {"id": 4, "name": "Student A (Juan)", "role": "student", "balance": 150.00, "borrowed_plates": 0, "borrowed_cutlery": 0},
    5: {"id": 5, "name": "Student B (Maria)", "role": "student", "balance": 80.00, "borrowed_plates": 0, "borrowed_cutlery": 0}
}

return_tokens_db: Dict[str, dict] = {}
orders_db: List[dict] = []
order_counter = 100

# --- Request Models ---

class CartItem(BaseModel):
    id: int
    qty: int

class CheckoutRequest(BaseModel):
    user_id: int
    order_type: str
    cart_items: List[CartItem]
    plates_borrowed: int = 0
    cutlery_borrowed: int = 0

class UpdateStockRequest(BaseModel):
    admin_id: int
    stock_status: StockStatus

class CreateReturnTokenRequest(BaseModel):
    student_id: int
    plates: int
    cutlery: int

class ProcessScannedTokenRequest(BaseModel):
    admin_id: int
    token: str
    action: str  # "deposit" or "return"
    deposit_amount: Optional[float] = None

class UpdateOrderStatusRequest(BaseModel):
    admin_id: int
    status: OrderStatus

class StudentLoanSummary(BaseModel):
    student_id: int
    student_name: str
    borrowed_counts: Dict[str, int]
    total_unreturned: int

class ManualReturnOverrideRequest(BaseModel):
    admin_id: int
    student_id: int
    refund_deposit: bool = True

# --- API Endpoints ---

@app.get("/api/users")
def get_all_users():
    return list(users_db.values())

@app.get("/api/users/{user_id}")
def get_user_profile(user_id: int):
    user = users_db.get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user

@app.get("/api/menu", response_model=List[MenuItem])
def get_menu():
    return menu_db

@app.patch("/api/admin/menu/{item_id}/stock")
def update_item_stock(item_id: int, req: UpdateStockRequest):
    admin = users_db.get(req.admin_id)
    if not admin or admin["role"] not in ["super_admin", "kitchen"]:
        raise HTTPException(
            status_code=403, 
            detail="Unauthorized. Only Super Admin and Kitchen Staff can adjust stock."
        )
    
    dish = next((m for m in menu_db if m.id == item_id), None)
    if not dish:
        raise HTTPException(status_code=404, detail="Dish not found.")
    
    dish.stock_status = req.stock_status
    return {
        "message": f"{dish.name} status updated to {dish.stock_status.value}", 
        "stock_status": dish.stock_status
    }

@app.post("/api/wallet/checkout")
def checkout_order(req: CheckoutRequest):
    global order_counter
    user = users_db.get(req.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    food_subtotal = 0.0
    detailed_items = []
    for item in req.cart_items:
        dish = next((m for m in menu_db if m.id == item.id), None)
        if not dish:
            raise HTTPException(status_code=400, detail=f"Dish {item.id} not found.")
        if dish.stock_status == StockStatus.SOLD_OUT:
            raise HTTPException(status_code=400, detail=f"Cannot order {dish.name}, it is sold out!")
        food_subtotal += dish.price * item.qty
        detailed_items.append({"name": dish.name, "qty": item.qty, "price": dish.price})

    plate_deposit = req.plates_borrowed * DEPOSIT_RATES["plate"]
    cutlery_deposit = req.cutlery_borrowed * DEPOSIT_RATES["spoon_fork_set"]
    grand_total = food_subtotal + plate_deposit + cutlery_deposit

    if user["balance"] < grand_total:
        raise HTTPException(status_code=400, detail=f"Insufficient balance! Required: ₱{grand_total:.2f}, Balance: ₱{user['balance']:.2f}")

    user["balance"] -= grand_total
    user["borrowed_plates"] += req.plates_borrowed
    user["borrowed_cutlery"] += req.cutlery_borrowed

    order_counter += 1
    new_order = {
        "order_id": str(uuid.uuid4().hex[:6]),
        "order_number": order_counter,
        "student_id": user["id"],
        "student_name": user["name"],
        "order_type": req.order_type,
        "items": detailed_items,
        "plates_borrowed": req.plates_borrowed,
        "cutlery_borrowed": req.cutlery_borrowed,
        "status": OrderStatus.PENDING,
        "created_at": time.strftime("%I:%M %p"),
        "total_charged": grand_total,
        "staff_note": ""  # Initialized empty for internal staff notes
    }
    orders_db.append(new_order)

    return {
        "status": "success",
        "order_number": order_counter,
        "order_id": new_order["order_id"],
        "food_subtotal": food_subtotal,
        "deposit_fee": plate_deposit + cutlery_deposit,
        "total_charged": grand_total,
        "new_balance": user["balance"]
    }
class UpdateOrderNoteRequest(BaseModel):
    admin_id: int
    staff_note: str

@app.patch("/api/admin/orders/{order_id}/note")
def update_order_note(order_id: str, req: UpdateOrderNoteRequest):
    admin = users_db.get(req.admin_id)
    # Visible & editable only by Super Admin, Kitchen, and Cashier
    if not admin or admin["role"] not in ["super_admin", "kitchen", "cashier"]:
        raise HTTPException(status_code=403, detail="Unauthorized. Students cannot update staff notes.")

    order = next((o for o in orders_db if o["order_id"] == order_id), None)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found.")

    order["staff_note"] = req.staff_note
    return {"message": "Note updated", "staff_note": order["staff_note"]}

@app.post("/api/qr/generate-return-token")
def generate_return_token(req: CreateReturnTokenRequest):
    student = users_db.get(req.student_id)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found.")
    
    if req.plates > student["borrowed_plates"]:
        raise HTTPException(status_code=400, detail=f"Cannot return {req.plates} plates. You have {student['borrowed_plates']}.")
    if req.cutlery > student["borrowed_cutlery"]:
        raise HTTPException(status_code=400, detail=f"Cannot return {req.cutlery} utensil sets. You have {student['borrowed_cutlery']}.")

    token = f"ret_{uuid.uuid4().hex[:8]}"
    return_tokens_db[token] = {
        "student_id": req.student_id,
        "plates": req.plates,
        "cutlery": req.cutlery,
        "created_at": time.time(),
        "claimed": False
    }

    return {
        "token": token,
        "qr_payload": {
            "type": "return",
            "token": token,
            "student_id": req.student_id,
            "plates": req.plates,
            "cutlery": req.cutlery
        }
    }

@app.post("/api/admin/process-qr-scan")
def process_qr_scan(req: ProcessScannedTokenRequest):
    admin = users_db.get(req.admin_id)
    # Allow both super_admin and cashier to process counter scans
    if not admin or admin["role"] not in ["super_admin", "cashier"]:
        raise HTTPException(status_code=403, detail="Unauthorized. Kitchen staff cannot scan payments or returns.")

    # 1. Cash Deposit Scan
    if req.action == "deposit":
        try:
            target_id = int(req.token.replace("dep_", ""))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid deposit token format.")

        student = users_db.get(target_id)
        if not student:
            raise HTTPException(status_code=404, detail="Student account not found.")

        if not req.deposit_amount or req.deposit_amount <= 0:
            raise HTTPException(status_code=400, detail="Enter a valid cash deposit amount.")

        student["balance"] += req.deposit_amount
        return {
            "status": "success",
            "message": f"Deposited ₱{req.deposit_amount:.2f} for {student['name']}.",
            "student_name": student["name"],
            "new_balance": student["balance"]
        }

    # 2. Tableware Return Scan (Cashier or Super Admin)
    elif req.action == "return":
        record = return_tokens_db.get(req.token)
        if not record:
            raise HTTPException(status_code=404, detail="Return token not found or expired.")
        if record["claimed"]:
            raise HTTPException(status_code=400, detail="This return token has already been claimed.")

        student = users_db.get(record["student_id"])
        if not student:
            raise HTTPException(status_code=404, detail="Associated student not found.")

        refund_total = (record["plates"] * DEPOSIT_RATES["plate"]) + (record["cutlery"] * DEPOSIT_RATES["spoon_fork_set"])
        student["borrowed_plates"] -= record["plates"]
        student["borrowed_cutlery"] -= record["cutlery"]
        student["balance"] += refund_total
        record["claimed"] = True

        return {
            "status": "success",
            "message": f"Refund verified for {student['name']}.",
            "student_name": student["name"],
            "refund_amount": refund_total,
            "new_balance": student["balance"]
        }

    raise HTTPException(status_code=400, detail="Unknown action type.")

@app.get("/api/orders/queue")
def get_order_queue():
    """Returns all orders so the kitchen/admin can filter by Pending, Preparing, Ready, and Completed."""
    # Return all orders in reverse chronological order (newest first)
    return list(reversed(orders_db))

@app.get("/api/orders/student/{student_id}")
def get_student_active_orders(student_id: int):
    return [o for o in orders_db if o["student_id"] == student_id and o["status"] != OrderStatus.COMPLETED]

@app.patch("/api/admin/orders/{order_id}/status")
def update_order_status(order_id: str, req: UpdateOrderStatusRequest):
    admin = users_db.get(req.admin_id)
    if not admin or admin["role"] not in ["super_admin", "kitchen"]:
        raise HTTPException(status_code=403, detail="Unauthorized. Only Super Admin or Kitchen can advance orders.")

    order = next((o for o in orders_db if o["order_id"] == order_id), None)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found.")

    order["status"] = req.status
    return {"message": f"Order #{order['order_number']} is now {req.status.value}", "order": order}

@app.get("/api/admin/active-loans", response_model=List[StudentLoanSummary])
def get_active_student_loans():
    active_loans = []
    for user_id, user in users_db.items():
        if user["role"] != "student":
            continue
        plates = user.get("borrowed_plates", 0)
        cutlery = user.get("borrowed_cutlery", 0)
        total = plates + cutlery
        if total > 0:
            counts = {}
            if plates > 0: counts["Plate"] = plates
            if cutlery > 0: counts["Spoon & Fork Set"] = cutlery
            active_loans.append(StudentLoanSummary(
                student_id=user["id"],
                student_name=user["name"],
                borrowed_counts=counts,
                total_unreturned=total
            ))
    return active_loans

@app.post("/api/admin/manual-return-override")
def manual_return_override(req: ManualReturnOverrideRequest):
    admin = users_db.get(req.admin_id)
    if not admin or admin["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Unauthorized. Only Super Admin can override tableware.")

    student = users_db.get(req.student_id)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found.")

    plates = student.get("borrowed_plates", 0)
    cutlery = student.get("borrowed_cutlery", 0)
    refund_total = 0.0
    if req.refund_deposit:
        refund_total = (plates * DEPOSIT_RATES["plate"]) + (cutlery * DEPOSIT_RATES["spoon_fork_set"])
        student["balance"] += refund_total

    student["borrowed_plates"] = 0
    student["borrowed_cutlery"] = 0

    return {
        "status": "success",
        "message": f"Cleared inventory for {student['name']}.",
        "refund_issued": refund_total,
        "new_balance": student["balance"]
    }

# --- STATIC FILES MOUNT (MUST REMAIN AT THE VERY BOTTOM) ---

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "frontend"))

@app.get("/")
def serve_index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail=f"index.html not found in {FRONTEND_DIR}")
    return FileResponse(index_path)

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")