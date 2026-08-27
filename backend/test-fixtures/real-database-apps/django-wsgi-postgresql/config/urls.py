from django.db import connection
from django.http import JsonResponse
from django.urls import path

def health(_request):
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
    return JsonResponse({"status": "ok", "database": "postgres"})

urlpatterns = [path("health", health)]
