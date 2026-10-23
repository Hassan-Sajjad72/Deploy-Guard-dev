import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { User } from './user.entity';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    private jwtService: JwtService,
  ) {}

  async register(email: string, password: string) {
    const exists = await this.userRepo.findOne({ where: { email } });
    if (exists) throw new ConflictException('Email already registered');
    const user = this.userRepo.create({ email, password: await bcrypt.hash(password, 12) });
    await this.userRepo.save(user);
    return this.generateTokenResponse(user);
  }

  async login(email: string, password: string) {
    const user = await this.userRepo.findOne({ where: { email } });
    if (!user || !user.password) throw new UnauthorizedException('Invalid credentials');
    if (!await bcrypt.compare(password, user.password)) throw new UnauthorizedException('Invalid credentials');
    return this.generateTokenResponse(user);
  }

  async findOrCreateGithubUser(profile: any): Promise<User> {
    let user = await this.userRepo.findOne({ where: { githubId: profile.id } });
    if (!user) {
      user = this.userRepo.create({
        githubId: profile.id, githubUsername: profile.username,
        email: profile.emails?.[0]?.value || `${profile.username}@github.com`,
        githubAccessToken: profile.accessToken,
      });
    } else {
      user.githubAccessToken = profile.accessToken;
    }
    return this.userRepo.save(user);
  }

  generateTokenResponse(user: User) {
    const { password, ...safe } = user as any;
    return { token: this.jwtService.sign({ sub: user.id, email: user.email, role: user.role }), user: safe };
  }

  async validateUser(payload: any): Promise<User> {
    return this.userRepo.findOne({ where: { id: payload.sub } });
  }
}
