import os
from dotenv import load_dotenv
load_dotenv(); SECRET_KEY=os.environ['DJANGO_SECRET_KEY']; DEBUG=False; ALLOWED_HOSTS=['*']; ROOT_URLCONF='config.urls'; MIDDLEWARE=[]; INSTALLED_APPS=[]; TEMPLATES=[]
DATABASES={'default':{'ENGINE':'django.db.backends.mysql','NAME':os.environ['DB_NAME'],'USER':os.environ['DB_USER'],'PASSWORD':os.environ['DB_PASSWORD'],'HOST':os.environ['DB_HOST'],'PORT':os.environ['DB_PORT']}}
