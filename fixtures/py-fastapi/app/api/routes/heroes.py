from fastapi import APIRouter
from sqlmodel import Session, select

from app.models import Hero

router = APIRouter(prefix="/heroes", tags=["heroes"])


@router.get("/")
async def read_heroes(session: Session):
    return session.exec(select(Hero)).all()


@router.patch("/{hero_id}")
async def update_hero(hero_id: int, data: dict, session: Session):
    hero = session.get(Hero, hero_id)
    hero.name = data["name"]
    session.add(hero)
    session.commit()
    return hero
