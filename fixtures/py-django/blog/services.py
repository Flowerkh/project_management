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
