from django.core.management.base import BaseCommand

from blog.models import Comment


class Command(BaseCommand):
    help = '빈 댓글 정리'

    def handle(self, *args, **options):
        Comment.objects.filter(body='').delete()
