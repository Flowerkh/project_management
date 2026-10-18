from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Item, ItemTag, Tag


def list_items(db: Session):
    stmt = select(Item).join(ItemTag).join(Tag)
    return db.execute(stmt).scalars().all()


def create_item(db: Session, item_in):
    item = Item(**item_in.model_dump())
    db.add(item)
    db.commit()
    return item
