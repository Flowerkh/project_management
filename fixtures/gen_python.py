#!/usr/bin/env python3
"""Python 예제 프로젝트 생성 (정답이 알려진 작은 프로젝트들)
사용: python3 fixtures/gen_python.py [fixtures]
만드는 것: py-django, py-flask, py-fastapi
"""
import os
import shutil
import sys

BASE = sys.argv[1] if len(sys.argv) > 1 else 'fixtures'


def w(root, path, text, enc='utf-8'):
    p = os.path.join(BASE, root, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding=enc, newline='\n') as f:
        f.write(text.lstrip('\n'))


def reset(root):
    p = os.path.join(BASE, root)
    if os.path.exists(p):
        shutil.rmtree(p)


# ------------------------------------------------------------------ Django + DRF
def django():
    R = 'py-django'
    reset(R)
    w(R, 'manage.py', '''
#!/usr/bin/env python
import os
import sys

if __name__ == '__main__':
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)
''')
    w(R, 'mysite/__init__.py', '')
    w(R, 'mysite/settings.py', '''
"""Django settings for mysite."""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = 'dev'
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'rest_framework',
    'blog',
    'shop',
]
ROOT_URLCONF = 'mysite.urls'
TEMPLATES = [{
    'BACKEND': 'django.template.backends.django.DjangoTemplates',
    'DIRS': [BASE_DIR / 'templates'],
    'APP_DIRS': True,
}]
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': 'mysite',
    }
}
''')
    w(R, 'mysite/urls.py', '''
from django.contrib import admin
from django.urls import include, path
from django.views.generic import TemplateView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', TemplateView.as_view(template_name='home.html'), name='home'),
    path('blog/', include('blog.urls')),
    path('shop/', include(('shop.urls', 'shop'), namespace='shop')),
]
''')
    # ---- blog: 함수 뷰 + 제네릭 클래스 뷰 + 서비스 + 원시 SQL
    w(R, 'blog/__init__.py', '')
    w(R, 'blog/models.py', '''
from django.db import models


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class Category(models.Model):
    name = models.CharField(max_length=50)


class Post(TimeStamped):
    """게시글"""
    category = models.ForeignKey(Category, on_delete=models.CASCADE)
    title = models.CharField(max_length=200)
    body = models.TextField()
    published = models.BooleanField(default=False)


class Comment(TimeStamped):
    post = models.ForeignKey(Post, related_name='comments', on_delete=models.CASCADE)
    body = models.TextField()

    class Meta:
        db_table = 'tb_comment'
''')
    w(R, 'blog/forms.py', '''
from django import forms

from .models import Comment, Post


class PostForm(forms.ModelForm):
    class Meta:
        model = Post
        fields = ['category', 'title', 'body']


class CommentForm(forms.ModelForm):
    class Meta:
        model = Comment
        fields = ['body']
''')
    w(R, 'blog/services.py', '''
from django.db import connection

from .models import Post

POST_STATS_SQL = """
    SELECT c.name, COUNT(*)
      FROM blog_post p
      JOIN blog_category c ON c.id = p.category_id
     GROUP BY c.name
"""


def publish(post_id):
    Post.objects.filter(pk=post_id).update(published=True)


def category_stats():
    with connection.cursor() as cursor:
        cursor.execute(POST_STATS_SQL)
        return cursor.fetchall()
''')
    w(R, 'blog/views.py', '''
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse_lazy
from django.views.generic import CreateView, ListView, UpdateView

from . import services
from .forms import CommentForm, PostForm
from .models import Category, Post


def post_list(request):
    posts = Post.objects.filter(published=True).order_by('-created_at')
    return render(request, 'blog/post_list.html', {'posts': posts})


def post_detail(request, pk):
    post = get_object_or_404(Post, pk=pk)
    if request.method == 'POST':
        form = CommentForm(request.POST)
        if form.is_valid():
            comment = form.save(commit=False)
            comment.post = post
            comment.save()
            return redirect('blog:post_detail', pk=post.pk)
    else:
        form = CommentForm()
    return render(request, 'blog/post_detail.html', {'post': post, 'form': form})


def post_delete(request, pk):
    post = get_object_or_404(Post, pk=pk)
    post.delete()
    return redirect('blog:post_list')


def post_publish(request, pk):
    services.publish(pk)
    return redirect('blog:post_detail', pk=pk)


def stats(request):
    rows = services.category_stats()
    return render(request, 'blog/stats.html', {'rows': rows})


class PostCreateView(CreateView):
    model = Post
    form_class = PostForm
    success_url = reverse_lazy('blog:post_list')


class PostUpdateView(UpdateView):
    model = Post
    form_class = PostForm
    template_name = 'blog/post_edit.html'


class CategoryListView(ListView):
    model = Category
''')
    w(R, 'blog/urls.py', '''
from django.urls import path

from . import views

app_name = 'blog'

urlpatterns = [
    path('', views.post_list, name='post_list'),
    path('post/<int:pk>/', views.post_detail, name='post_detail'),
    path('post/new/', views.PostCreateView.as_view(), name='post_new'),
    path('post/<int:pk>/edit/', views.PostUpdateView.as_view(), name='post_edit'),
    path('post/<int:pk>/delete/', views.post_delete, name='post_delete'),
    path('post/<int:pk>/publish/', views.post_publish, name='post_publish'),
    path('categories/', views.CategoryListView.as_view(), name='category_list'),
    path('stats/', views.stats, name='stats'),
]
''')
    w(R, 'blog/management/__init__.py', '')
    w(R, 'blog/management/commands/__init__.py', '')
    w(R, 'blog/management/commands/cleanup_comments.py', '''
from django.core.management.base import BaseCommand

from blog.models import Comment


class Command(BaseCommand):
    help = '빈 댓글 정리'

    def handle(self, *args, **options):
        Comment.objects.filter(body='').delete()
''')
    w(R, 'blog/templates/blog/post_list.html', '''
{% extends 'base.html' %}
{% block title %}글 목록{% endblock %}
{% block content %}
<a href="{% url 'blog:post_new' %}">글 쓰기</a>
<ul>
{% for post in posts %}
  <li><a href="{% url 'blog:post_detail' post.pk %}">{{ post.title }}</a></li>
{% endfor %}
</ul>
{% endblock %}
''')
    w(R, 'blog/templates/blog/post_detail.html', '''
{% extends 'base.html' %}
{% block title %}글 보기{% endblock %}
{% block content %}
<h2>{{ post.title }}</h2>
<a href="{% url 'blog:post_edit' post.pk %}">수정</a>
<a href="{% url 'blog:post_publish' post.pk %}">게시</a>
<form method="post" action="{% url 'blog:post_delete' post.pk %}">{% csrf_token %}<button>삭제</button></form>
<form method="post">{% csrf_token %}{{ form.as_p }}<button>댓글 등록</button></form>
{% endblock %}
''')
    w(R, 'blog/templates/blog/post_form.html', '''
{% extends 'base.html' %}
{% block title %}글 쓰기{% endblock %}
{% block content %}<form method="post">{% csrf_token %}{{ form.as_p }}<button>저장</button></form>{% endblock %}
''')
    w(R, 'blog/templates/blog/post_edit.html', '''
{% extends 'base.html' %}
{% block title %}글 수정{% endblock %}
{% block content %}<form method="post">{% csrf_token %}{{ form.as_p }}<button>저장</button></form>{% endblock %}
''')
    w(R, 'blog/templates/blog/category_list.html', '''
{% extends 'base.html' %}
{% block title %}분류 목록{% endblock %}
{% block content %}{% for c in object_list %}<p>{{ c.name }}</p>{% endfor %}{% endblock %}
''')
    w(R, 'blog/templates/blog/stats.html', '''
{% extends 'base.html' %}
{% block title %}분류별 통계{% endblock %}
{% block content %}<table>{% for name, cnt in rows %}<tr><td>{{ name }}</td><td>{{ cnt }}</td></tr>{% endfor %}</table>{% endblock %}
''')
    # ---- shop: DRF ViewSet·라우터·@api_view·커스텀 매니저
    w(R, 'shop/__init__.py', '')
    w(R, 'shop/models.py', '''
from django.db import models


class ActiveManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(active=True)


class Product(models.Model):
    name = models.CharField(max_length=100)
    price = models.IntegerField()
    active = models.BooleanField(default=True)

    objects = models.Manager()
    actives = ActiveManager()


class Order(models.Model):
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    qty = models.IntegerField()
    status = models.CharField(max_length=20)

    class Meta:
        db_table = 'tb_order'
''')
    w(R, 'shop/serializers.py', '''
from rest_framework import serializers

from .models import Order, Product


class ProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = '__all__'


class OrderSerializer(serializers.ModelSerializer):
    class Meta:
        model = Order
        fields = '__all__'
''')
    w(R, 'shop/views.py', '''
from django.db import connection
from django.shortcuts import render
from rest_framework import mixins, viewsets
from rest_framework.decorators import action, api_view
from rest_framework.response import Response

from .models import Order, Product
from .serializers import OrderSerializer, ProductSerializer

SUMMARY_SQL = "SELECT status, COUNT(*) FROM tb_order GROUP BY status"


def product_list(request):
    products = Product.actives.all()
    return render(request, 'shop/product_list.html', {'products': products})


class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all()
    serializer_class = ProductSerializer


class OrderViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, viewsets.GenericViewSet):
    serializer_class = OrderSerializer

    def get_queryset(self):
        return Order.objects.select_related('product').filter(status='OPEN')

    @action(detail=True, methods=['post'])
    def cancel(self, request, pk=None):
        Order.objects.filter(pk=pk).update(status='CANCEL')
        return Response({'ok': True})


@api_view(['GET'])
def order_summary(request):
    with connection.cursor() as cursor:
        cursor.execute(SUMMARY_SQL)
        rows = cursor.fetchall()
    return Response(rows)
''')
    w(R, 'shop/urls.py', '''
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register(r'products', views.ProductViewSet)
router.register(r'orders', views.OrderViewSet, basename='order')

urlpatterns = [
    path('', views.product_list, name='product_list'),
    path('api/', include(router.urls)),
    path('api/summary/', views.order_summary, name='order_summary'),
]
''')
    w(R, 'shop/templates/shop/product_list.html', '''
{% extends 'base.html' %}
{% load static %}
{% block title %}상품 목록{% endblock %}
{% block content %}
<a href="{% url 'shop:order-list' %}">주문 API</a>
<div id="summary"></div>
<script src="{% static 'shop/js/summary.js' %}"></script>
<script>
  fetch("{% url 'shop:order_summary' %}").then(r => r.json());
</script>
{% endblock %}
''')
    # ---- 공통 템플릿
    w(R, 'templates/base.html', '''
<!doctype html>
<html>
<head><title>{% block title %}{% endblock %} - 마이사이트</title></head>
<body>
<nav>
  <a href="{% url 'home' %}">홈</a>
  <a href="{% url 'blog:post_list' %}">블로그</a>
  <a href="{% url 'shop:product_list' %}">상점</a>
</nav>
{% include 'includes/sidebar.html' %}
{% block content %}{% endblock %}
</body>
</html>
''')
    w(R, 'templates/home.html', '''
{% extends 'base.html' %}
{% block title %}홈{% endblock %}
{% block content %}<p>환영합니다</p>{% endblock %}
''')
    w(R, 'templates/includes/sidebar.html', '''
<ul class="menu">
  <li><a href="{% url 'blog:post_list' %}">글 목록</a></li>
  <li><a href="{% url 'blog:category_list' %}">분류</a></li>
  <li><a href="{% url 'shop:product_list' %}">상품</a></li>
</ul>
''')
    # ---- 배치: crontab + pymysql 스크립트 + 관리 명령
    w(R, 'batch/crontab', '''
# 쇼핑몰 배치
0 2 * * * /usr/bin/python3 /app/batch/daily_settle.py
30 3 * * * cd /app && python manage.py cleanup_comments
''')
    w(R, 'batch/daily_settle.py', '''
#!/usr/bin/env python
"""일별 정산 배치: 전날 주문을 모아 정산 테이블에 쌓는다."""
import logging

import pymysql

logging.basicConfig(filename='/var/log/shop/daily_settle.log', level=logging.INFO)

INSERT_SQL = (
    "INSERT INTO tb_settle_daily (settle_date, amount) "
    "SELECT DATE(created_at), SUM(qty) FROM tb_order "
    "WHERE status = %s GROUP BY DATE(created_at)"
)


def run(conn):
    with conn.cursor() as cur:
        cur.execute(INSERT_SQL, ('DONE',))
        cur.execute("DELETE FROM tb_order WHERE status = 'CANCEL'")
    conn.commit()


if __name__ == '__main__':
    run(pymysql.connect(host='db', user='shop', db='shop'))
''')
    w(R, 'sql/schema.sql', '''
CREATE TABLE blog_category (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(50), PRIMARY KEY (id)) COMMENT='게시판 분류';
CREATE TABLE blog_post (id INT NOT NULL AUTO_INCREMENT, category_id INT, title VARCHAR(200) COMMENT '제목', body TEXT, published TINYINT(1), created_at DATETIME, PRIMARY KEY (id)) COMMENT='게시글';
CREATE TABLE tb_comment (id INT NOT NULL AUTO_INCREMENT, post_id INT, body TEXT, created_at DATETIME, PRIMARY KEY (id)) COMMENT='댓글';
CREATE TABLE shop_product (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(100), price INT, active TINYINT(1), PRIMARY KEY (id)) COMMENT='상품';
CREATE TABLE tb_order (id INT NOT NULL AUTO_INCREMENT, product_id INT, qty INT, status VARCHAR(20), created_at DATETIME, PRIMARY KEY (id)) COMMENT='주문';
CREATE TABLE tb_settle_daily (settle_date DATE NOT NULL, amount BIGINT, PRIMARY KEY (settle_date)) COMMENT='일별 정산';
''')


# ------------------------------------------------------------------ Flask + Flask-SQLAlchemy
def flask():
    R = 'py-flask'
    reset(R)
    w(R, 'config.py', '''
class Config:
    SQLALCHEMY_DATABASE_URI = 'oracle+cx_oracle://scott:tiger@db:1521/?service_name=ORCL'
''')
    w(R, 'run.py', '''
from app import create_app

app = create_app()

if __name__ == '__main__':
    app.run(debug=True)
''')
    w(R, 'app/__init__.py', '''
from flask import Flask
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


def create_app():
    app = Flask(__name__)
    app.config.from_object('config.Config')
    db.init_app(app)

    from .main import main as main_blueprint
    app.register_blueprint(main_blueprint)

    from .admin import bp as admin_bp
    app.register_blueprint(admin_bp, url_prefix='/admin')

    from .api import api_bp
    app.register_blueprint(api_bp)
    return app
''')
    w(R, 'app/models.py', '''
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
''')
    w(R, 'app/main/__init__.py', '''
from flask import Blueprint

main = Blueprint('main', __name__)

from . import views  # noqa: E402,F401
''')
    w(R, 'app/main/views.py', '''
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
''')
    w(R, 'app/admin/__init__.py', '''
from flask import Blueprint

bp = Blueprint('admin', __name__, url_prefix='/manage')

from . import routes  # noqa: E402,F401
''')
    w(R, 'app/admin/service.py', '''
from sqlalchemy import select

from .. import db
from ..models import Member, Role


class MemberService:
    def list_members(self):
        stmt = select(Member).join(Role, Member.roles)
        return db.session.execute(stmt).scalars().all()


service = MemberService()
''')
    w(R, 'app/admin/routes.py', '''
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
''')
    w(R, 'app/api/__init__.py', '''
from flask import Blueprint

api_bp = Blueprint('api', __name__, url_prefix='/api/v1')

from . import notices  # noqa: E402,F401
''')
    w(R, 'app/api/notices.py', '''
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
''')
    w(R, 'app/templates/base.html', '''
<!doctype html>
<html>
<head>
<title>{% block title %}{% endblock %} | 사내 포털</title>
<link rel="stylesheet" href="{{ url_for('static', filename='css/app.css') }}">
</head>
<body>
<nav>
  <a href="{{ url_for('main.index') }}">공지</a>
  <a href="{{ url_for('admin.member_list') }}">회원 관리</a>
</nav>
{% block content %}{% endblock %}
</body>
</html>
''')
    w(R, 'app/templates/_macros.html', '''
{% macro pager(page) %}<span>{{ page }}</span>{% endmacro %}
''')
    w(R, 'app/templates/index.html', '''
{% extends "base.html" %}
{% import "_macros.html" as macros %}
{% block title %}공지사항{% endblock %}
{% block content %}
<a href="{{ url_for('.notice_new') }}">공지 등록</a>
{% for n in notices %}
  <a href="{{ url_for('main.notice_detail', notice_id=n.id) }}">{{ n.title }}</a>
{% endfor %}
{% endblock %}
''')
    w(R, 'app/templates/notice_detail.html', '''
{% extends "base.html" %}
{% block title %}공지 상세{% endblock %}
{% block content %}
<h1>{{ notice.title }}</h1>
<button onclick="remove()">삭제</button>
<script>
function remove() {
  fetch("{{ url_for('api.notice_api', notice_id=notice.id) }}", { method: 'DELETE' });
}
</script>
{% endblock %}
''')
    w(R, 'app/templates/notice_form.html', '''
{% extends "base.html" %}
{% block title %}공지 등록{% endblock %}
{% block content %}<form method="post"><input name="title"><button>저장</button></form>{% endblock %}
''')
    w(R, 'app/templates/admin/members.html', '''
{% extends "base.html" %}
{% block title %}회원 관리{% endblock %}
{% block content %}
{% for m in members %}
<form method="post" action="{{ url_for('admin.member_delete', member_id=m.member_id) }}"><button>삭제</button></form>
{% endfor %}
{% endblock %}
''')
    w(R, 'app/templates/admin/stats.html', '''
{% extends "base.html" %}
{% block title %}권한 통계{% endblock %}
{% block content %}{% for r in rows %}<p>{{ r[0] }} {{ r[1] }}</p>{% endfor %}{% endblock %}
''')
    # ---- 배치: crontab + cx_Oracle
    w(R, 'crontab', '''
0 1 * * * /usr/bin/python3 /app/jobs/sync_erp.py >> /var/log/sync_erp.log 2>&1
''')
    w(R, 'jobs/__init__.py', '')
    w(R, 'jobs/common.py', '''
import cx_Oracle


def get_conn():
    return cx_Oracle.connect('scott/tiger@db:1521/ORCL')
''')
    w(R, 'jobs/sync_erp.py', '''
"""ERP 회원 동기화 - 매일 새벽 ERP 사용자 정보를 회원 테이블에 반영"""
import cx_Oracle  # noqa: F401

from jobs.common import get_conn

SELECT_ERP = "SELECT USER_ID, USER_NM, EMAIL FROM ERP_USER WHERE UPD_DT >= SYSDATE - 1"


def sync(conn):
    cur = conn.cursor()
    cur.execute(SELECT_ERP)
    for row in cur.fetchall():
        cur.execute("UPDATE TB_MEMBER SET NAME = :1 WHERE MEMBER_ID = :2", (row[1], row[0]))
    conn.commit()


if __name__ == '__main__':
    sync(get_conn())
''')
    w(R, 'sql/oracle_ddl.sql', '''
CREATE TABLE TB_MEMBER (MEMBER_ID NUMBER(10) NOT NULL, NAME VARCHAR2(50), CONSTRAINT PK_TB_MEMBER PRIMARY KEY (MEMBER_ID));
COMMENT ON TABLE TB_MEMBER IS '회원';
CREATE TABLE TB_ROLE (ROLE_ID NUMBER(10) NOT NULL, CONSTRAINT PK_TB_ROLE PRIMARY KEY (ROLE_ID));
COMMENT ON TABLE TB_ROLE IS '권한';
CREATE TABLE TB_MEMBER_ROLE (MEMBER_ID NUMBER(10), ROLE_ID NUMBER(10));
COMMENT ON TABLE TB_MEMBER_ROLE IS '회원 권한';
CREATE TABLE NOTICE (ID NUMBER(10) NOT NULL, TITLE VARCHAR2(200), CONSTRAINT PK_NOTICE PRIMARY KEY (ID));
COMMENT ON TABLE NOTICE IS '공지사항';
CREATE TABLE NOTICE_FILE (ID NUMBER(10) NOT NULL, NOTICE_ID NUMBER(10), CONSTRAINT PK_NOTICE_FILE PRIMARY KEY (ID));
COMMENT ON TABLE NOTICE_FILE IS '공지 첨부파일';
CREATE TABLE ERP_USER (USER_ID VARCHAR2(20) NOT NULL, USER_NM VARCHAR2(50), EMAIL VARCHAR2(100), UPD_DT DATE);
COMMENT ON TABLE ERP_USER IS 'ERP 사용자';
''')


# ------------------------------------------------------------------ FastAPI + SQLAlchemy 2.0 + SQLModel
def fastapi():
    R = 'py-fastapi'
    reset(R)
    w(R, 'app/__init__.py', '')
    w(R, 'app/core/__init__.py', '')
    w(R, 'app/core/config.py', '''
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    API_V1_STR: str = "/api/v1"
    DATABASE_URL: str = "postgresql+psycopg2://app:app@db/app"


settings = Settings()
''')
    w(R, 'app/db.py', '''
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.core.config import settings

engine = create_engine(settings.DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
''')
    w(R, 'app/models.py', '''
from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlmodel import Field, SQLModel

from app.db import Base


class Item(Base):
    __tablename__ = "items"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(100))


class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(primary_key=True)


class ItemTag(Base):
    __tablename__ = "item_tags"
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id"), primary_key=True)


class HeroBase(SQLModel):
    name: str


class Hero(HeroBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
''')
    w(R, 'app/crud.py', '''
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
''')
    w(R, 'app/api/__init__.py', '')
    w(R, 'app/api/main.py', '''
from fastapi import APIRouter

from app.api.routes import heroes, items

api_router = APIRouter()
api_router.include_router(items.router)
api_router.include_router(heroes.router)
''')
    w(R, 'app/api/routes/items.py', '''
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
''')
    w(R, 'app/api/routes/heroes.py', '''
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
''')
    w(R, 'app/pages.py', '''
from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Item

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")


@router.get("/dashboard", response_class=HTMLResponse)
def dashboard(request: Request, db: Session = Depends(get_db)):
    count = db.scalar(select(func.count()).select_from(Item))
    return templates.TemplateResponse(request, "dashboard.html", {"count": count})
''')
    w(R, 'app/main.py', '''
from fastapi import FastAPI

from app import pages
from app.api.main import api_router
from app.core.config import settings

app = FastAPI(title="Items")
app.include_router(api_router, prefix=settings.API_V1_STR)
app.include_router(pages.router)
''')
    w(R, 'app/templates/dashboard.html', '''
<!doctype html>
<html>
<head><title>대시보드</title></head>
<body>
<p>품목 {{ count }}개</p>
<a href="{{ url_for('read_heroes') }}">영웅 목록</a>
<script>
fetch('/api/v1/items/').then(r => r.json());
</script>
</body>
</html>
''')


if __name__ == '__main__':
    os.makedirs(BASE, exist_ok=True)
    django()
    flask()
    fastapi()
    print('generated: py-django, py-flask, py-fastapi')
