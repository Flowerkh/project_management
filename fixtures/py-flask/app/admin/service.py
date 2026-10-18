from sqlalchemy import select

from .. import db
from ..models import Member, Role


class MemberService:
    def list_members(self):
        stmt = select(Member).join(Role, Member.roles)
        return db.session.execute(stmt).scalars().all()


service = MemberService()
