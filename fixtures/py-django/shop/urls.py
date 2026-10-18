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
