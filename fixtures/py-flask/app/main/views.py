from flask import redirect, render_template, request, url_for

from . import main
from .. import db
from ..models import Notice, NoticeFile


@main.route('/')
def index():
    notices = Notice.query.order_by(Notice.id.desc()).limit(5).all()
    return render_template('index.html', notices=notices)


@main.route('/notice/<int:notice_id>')
def notice_detail(notice_id):
    notice = db.get_or_404(Notice, notice_id)
    files = NoticeFile.query.filter_by(notice_id=notice_id).all()
    return render_template('notice_detail.html', notice=notice, files=files)


@main.route('/notice/new', methods=['GET', 'POST'])
def notice_new():
    if request.method == 'POST':
        notice = Notice(title=request.form['title'])
        db.session.add(notice)
        db.session.commit()
        return redirect(url_for('.notice_detail', notice_id=notice.id))
    return render_template('notice_form.html')
