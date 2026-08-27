import os

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "fixture-secret")
DEBUG = False
ALLOWED_HOSTS = ["*"]
ROOT_URLCONF = "config.urls"
MIDDLEWARE = []
INSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.staticfiles"]
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "HOST": os.environ["DB_HOST"],
        "PORT": os.environ.get("DB_PORT", "5432"),
        "NAME": os.environ["DB_NAME"],
        "USER": os.environ["DB_USER"],
        "PASSWORD": os.environ["DB_PASSWORD"],
    }
}
STATIC_URL = "/static/"
STATIC_ROOT = "/tmp/deployguard-static"
