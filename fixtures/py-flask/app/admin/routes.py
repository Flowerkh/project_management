from flask import redirect, render_template, url_for
from sqlalchemy import text

from . import bp
from .service import service
from .. import db
from ..models import Member


@bp.get('/members')
def member_list():
    members = service.list_members()
    return render_template('admin/members.html', members=members)


@bp.post('/members/<int:member_id>/delete')
def member_delete(member_id):
    Member.query.filter_by(member_id=member_id).delete()
    db.session.commit()
    return redirect(url_for('admin.member_list'))


@bp.route('/stats')
def stats():
    rows = db.session.execute(text("SELECT ROLE_ID, COUNT(*) FROM TB_MEMBER_ROLE GROUP BY ROLE_ID")).all()
    return render_template('admin/stats.html', rows=rows)
