from . import db

member_roles = db.Table(
    'TB_MEMBER_ROLE',
    db.Column('member_id', db.Integer, db.ForeignKey('TB_MEMBER.member_id')),
    db.Column('role_id', db.Integer, db.ForeignKey('TB_ROLE.role_id')),
)


class Member(db.Model):
    __tablename__ = 'TB_MEMBER'
    member_id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50))
    roles = db.relationship('Role', secondary=member_roles)


class Role(db.Model):
    __tablename__ = 'TB_ROLE'
    role_id = db.Column(db.Integer, primary_key=True)


class Notice(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200))


class NoticeFile(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    notice_id = db.Column(db.Integer, db.ForeignKey('notice.id'))
