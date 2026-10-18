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
