from flask import jsonify, request
from flask.views import MethodView
from sqlalchemy import update

from . import api_bp
from .. import db
from ..models import Notice


@api_bp.route('/notices')
def list_notices():
    return jsonify([n.title for n in Notice.query.all()])


@api_bp.route('/notices', methods=['POST'])
def create_notice():
    db.session.add(Notice(title=request.json['title']))
    db.session.commit()
    return jsonify({'ok': True}), 201


class NoticeAPI(MethodView):
    def get(self, notice_id):
        notice = Notice.query.get_or_404(notice_id)
        return jsonify({'title': notice.title})

    def put(self, notice_id):
        stmt = update(Notice).where(Notice.id == notice_id).values(title=request.json['title'])
        db.session.execute(stmt)
        db.session.commit()
        return jsonify({'ok': True})

    def delete(self, notice_id):
        notice = db.session.get(Notice, notice_id)
        db.session.delete(notice)
        db.session.commit()
        return '', 204


api_bp.add_url_rule('/notices/<int:notice_id>', view_func=NoticeAPI.as_view('notice_api'), methods=['GET', 'PUT', 'DELETE'])
