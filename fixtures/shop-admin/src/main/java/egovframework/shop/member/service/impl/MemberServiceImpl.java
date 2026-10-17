package egovframework.shop.member.service.impl;

import javax.annotation.Resource;
import org.springframework.stereotype.Service;
import egovframework.rte.fdl.cmmn.EgovAbstractServiceImpl;
import egovframework.shop.member.service.MemberService;
import egovframework.shop.member.service.MemberVO;

@Service("memberservice")
public class MemberServiceImpl extends EgovAbstractServiceImpl implements MemberService {

    @Resource(name = "membermapper")
    private MemberMapper membermapper;

    @Override
    public Object selectMemberList(MemberVO vo) throws Exception {
        return membermapper.selectMemberList(vo);
    }

    @Override
    public Object selectMember(MemberVO vo) throws Exception {
        return membermapper.selectMember(vo);
    }

    @Override
    public Object selectMemberAddrList(MemberVO vo) throws Exception {
        return membermapper.selectMemberAddrList(vo);
    }

    @Override
    public Object updateMemberGrade(MemberVO vo) throws Exception {
        return membermapper.updateMemberGrade(vo);
    }

    @Override
    public Object selectGradeList(MemberVO vo) throws Exception {
        return membermapper.selectGradeList(vo);
    }

    @Override
    public Object updateGrade(MemberVO vo) throws Exception {
        return membermapper.updateGrade(vo);
    }

    @Override
    public Object selectDormantList(MemberVO vo) throws Exception {
        return membermapper.selectDormantList(vo);
    }

}
