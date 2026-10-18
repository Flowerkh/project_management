from fastapi import APIRouter, Depends
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app import crud
from app.db import get_db
from app.models import Item

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/")
def read_items(db: Session = Depends(get_db)):
    return crud.list_items(db)


@router.post("/", status_code=201)
def create_item(item_in: dict, db: Session = Depends(get_db)):
    return crud.create_item(db, item_in)


@router.get("/{item_id}")
def read_item(item_id: int, db: Session = Depends(get_db)):
    return db.get(Item, item_id)


@router.delete("/{item_id}")
def delete_item(item_id: int, db: Session = Depends(get_db)):
    db.execute(delete(Item).where(Item.id == item_id))
    db.commit()
