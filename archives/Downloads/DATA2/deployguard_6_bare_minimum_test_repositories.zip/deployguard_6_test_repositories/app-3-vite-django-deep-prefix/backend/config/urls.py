from django.urls import path
from rest_framework.decorators import api_view
from rest_framework.response import Response

@api_view(["GET"])
def status(_request):
    return Response({"status": "ok"})

urlpatterns = [
    path("v1/engine/status", status),
]
