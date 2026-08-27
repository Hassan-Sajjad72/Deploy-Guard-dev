from django.http import JsonResponse
from django.urls import path
from django.db import connection
def root(r): return JsonResponse({'framework':'django','ok':True})
def health(r):
 with connection.cursor() as q: q.execute('SELECT 1'); q.fetchone()
 return JsonResponse({'status':'ok'})
urlpatterns=[path('',root),path('health',health)]
