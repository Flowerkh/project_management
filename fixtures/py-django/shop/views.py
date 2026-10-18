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
